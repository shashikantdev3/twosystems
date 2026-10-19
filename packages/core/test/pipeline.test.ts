// Tests for the state builder and the decision pipeline. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvent } from "../src/contracts.js";
import { RulesEngine } from "../src/engines/rules.js";
import { type DecisionEngine, EngineError } from "../src/engines/types.js";
import { builtInLock, defaultLock, lockHash } from "../src/lock.js";
import { type EvaluateInput, evaluate, sessionToken } from "../src/pipeline.js";
import { REDACTED } from "../src/redact.js";
import type { Observation } from "../src/signals.js";
import { STATE_LIMITS, buildState } from "../src/state.js";

const T0 = Date.parse("2026-10-19T10:00:00Z");
const fakeKey = ["sk-", "or-v1-", "0123456789abcdef".repeat(4)].join("");

const stuckSession: Observation[] = [
  { kind: "prompt", at: T0, text: `Make the login test pass. My key is ${fakeKey}` },
  ...Array.from({ length: 4 }, (_, i) => ({
    kind: "tool" as const,
    at: T0 + (i + 1) * 10_000,
    tool: "bash",
    command: "npm test -- login",
    ok: false,
    error: `AssertionError: expected 200, got 500\n    at test/login.test.ts:${10 + i}:3`,
  })),
  { kind: "context", at: T0 + 50_000, tokens: 42_000, window: 200_000 },
];

test("the state summary is short, redacted and hashed", () => {
  const state = buildState({ name: "stuck", observations: stuckSession, signals: ["repeated_error"], now: T0 + 60_000 });
  const text = state.lines.join("\n");
  assert.ok(!text.includes(fakeKey), "the key leaked into the state");
  assert.ok(text.includes(REDACTED));
  assert.ok(text.includes("npm test -- login -> failed: AssertionError"));
  assert.ok(text.includes("Conversation size: 42000 tokens (21% of the window)."));
  assert.ok(text.length <= STATE_LIMITS.totalChars);
  assert.match(state.hash, /^sha256:[0-9a-f]{64}$/);
  const again = buildState({ name: "stuck", observations: stuckSession, signals: ["repeated_error"], now: T0 + 60_000 });
  assert.equal(again.hash, state.hash);
});

test("a long secret is redacted before the line is shortened", () => {
  const prompt = `${"x ".repeat(190)}${fakeKey}`;
  const state = buildState({ name: "fresh_start", observations: [{ kind: "prompt", at: T0, text: prompt }], signals: [], now: T0 });
  assert.ok(!state.lines.join("").includes(fakeKey.slice(0, 20)));
});

function input(over: Partial<EvaluateInput>): EvaluateInput {
  const engine = new RulesEngine();
  return {
    name: "stuck",
    observations: stuckSession,
    now: T0 + 60_000,
    engine,
    lock: builtInLock(engine.info),
    holdoutRate: 0,
    timeoutMs: 1000,
    cacheTtlSeconds: 300,
    agent: "claude-code",
    session: "session-1",
    adapterVersion: "0.1.0",
    random: () => 0.5,
    ...over,
  };
}

test("no signal, no decision and no event", async () => {
  const result = await evaluate(input({ observations: [{ kind: "prompt", at: T0, text: "hello" }] }));
  assert.deepEqual(result, { signals: [] });
});

test("a stuck session with the rules engine gives a valid act event and a pause suggestion", async () => {
  const result = await evaluate(input({}));
  assert.deepEqual(result.signals, ["repeated_command", "repeated_error"]);
  assert.equal(result.show, "pause");
  const event = result.event;
  assert.ok(event !== undefined);
  assert.deepEqual(validateEvent(event), { ok: true, errors: [] });
  assert.equal(event.decision.band, "act");
  assert.equal(event.decision.holdout, false);
  assert.equal(event.decision.lock_hash, builtInLock({ kind: "rules" }).hash);
  assert.deepEqual(event.decision.probabilities, { progressing: 0.125, stuck: 0.875 });
});

test("the holdout keeps a due suggestion silent and records it", async () => {
  const result = await evaluate(input({ holdoutRate: 0.1, random: () => 0.05 }));
  assert.equal(result.show, undefined);
  assert.equal(result.event?.decision.holdout, true);
  assert.equal(result.event?.decision.reason, "holdout");
  assert.equal(result.event?.decision.band, "act");
});

function engineThat(behaviour: "slow" | "fail" | "hang"): DecisionEngine {
  return {
    info: { kind: "openrouter", model: "test/model" },
    remote: true,
    decide: () =>
      behaviour === "fail"
        ? Promise.reject(new EngineError("http_error", "HTTP 503", 503))
        : behaviour === "slow"
          ? new Promise((resolve) => setTimeout(() => resolve({ probabilities: { progressing: 0, stuck: 1 } }), 500))
          : new Promise(() => undefined),
  };
}

test("engine failures and timeouts become silent not_evaluated records", async () => {
  for (const [behaviour, reason] of [["fail", "http_error"], ["slow", "timeout"], ["hang", "timeout"]] as const) {
    const result = await evaluate(input({ engine: engineThat(behaviour), timeoutMs: 50 }));
    assert.equal(result.show, undefined, behaviour);
    assert.equal(result.event?.decision.band, "not_evaluated");
    assert.equal(result.event?.decision.reason, reason);
    assert.deepEqual(validateEvent(result.event), { ok: true, errors: [] });
  }
});

test("a fitted lock is used only when it matches the engine and the question", async () => {
  const engine: DecisionEngine = {
    info: { kind: "openrouter", model: "test/model" },
    remote: true,
    decide: () => Promise.resolve({ probabilities: { progressing: 0.2, stuck: 0.8 }, modelVersion: "test/model-2026", costUsd: 0.00001 }),
  };
  // Built-in model thresholds act at 0.9, so 0.8 is only "unsure".
  const builtIn = await evaluate(input({ engine, lock: builtInLock(engine.info) }));
  assert.equal(builtIn.event?.decision.band, "unsure");
  assert.equal(builtIn.event?.decision.engine.model_version, "test/model-2026");
  assert.equal(builtIn.event?.decision.cost_usd, 0.00001);

  const fitted = defaultLock(engine.info);
  if (fitted.decisions.stuck) fitted.decisions.stuck.thresholds = { stuck: { act: 0.75, unsure: 0.5 } };
  const loaded = { lock: fitted, hash: lockHash(fitted), source: "/tmp/decisions.lock" };
  const used = await evaluate(input({ engine, lock: loaded }));
  assert.equal(used.event?.decision.band, "act");
  assert.equal(used.event?.decision.reason, undefined);

  const other = defaultLock({ kind: "openrouter", model: "another/model" });
  if (other.decisions.stuck) other.decisions.stuck.thresholds = { stuck: { act: 0.75, unsure: 0.5 } };
  const mismatched = await evaluate(input({ engine, lock: { lock: other, hash: lockHash(other), source: "/tmp/x.lock" } }));
  assert.equal(mismatched.event?.decision.band, "unsure");
  assert.equal(mismatched.event?.decision.reason, "lock_mismatch");
});

test("session ids that are not plain tokens are hashed", () => {
  assert.equal(sessionToken("abc-123"), "abc-123");
  assert.match(sessionToken("a session with spaces"), /^s-[0-9a-f]{16}$/);
  assert.equal(sessionToken("x".repeat(200)), sessionToken("x".repeat(200)));
});

test("without an injected random source the holdout still works", async () => {
  let held = 0;
  for (let i = 0; i < 200; i += 1) {
    const { random: _unused, ...rest } = input({ holdoutRate: 0.5 });
    const result = await evaluate(rest);
    if (result.event?.decision.holdout) held += 1;
  }
  assert.ok(held > 60 && held < 140, `held back ${held} of 200`);
});

test("when the summary is too long, the newest evidence is kept and the oldest dropped", () => {
  const long = (i: number) => `step ${i} ${"detail ".repeat(60)}`;
  const observations: Observation[] = [
    { kind: "prompt", at: T0, text: long(0) },
    { kind: "prompt", at: T0 + 1, text: long(1) },
    ...Array.from({ length: 10 }, (_, i) => ({ kind: "tool" as const, at: T0 + 10 + i, tool: "bash", command: `npm test ${i} ${"--flag ".repeat(30)}`, ok: false, error: long(i) })),
    { kind: "context", at: T0 + 100, tokens: 90_000 },
  ];
  const state = buildState({ name: "stuck", observations, signals: ["repeated_error"], now: T0 + 200 });
  const text = state.lines.join("\n");
  assert.ok(text.length <= STATE_LIMITS.totalChars);
  assert.ok(text.includes("Rule signals: repeated_error."));
  assert.ok(text.includes("Conversation size: 90000 tokens."));
  assert.ok(text.includes("npm test 9"), "the newest call was dropped");
  assert.ok(!text.includes("npm test 2 "), "an old call was kept over a newer one");
  assert.ok(!text.includes("Task at the start"), "an old prompt was kept over newer evidence");
  // Kept lines stay in their natural order.
  assert.ok(text.indexOf("npm test 8") < text.indexOf("npm test 9"));
});
