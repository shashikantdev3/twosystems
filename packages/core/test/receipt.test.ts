// Tests for the receipt maths. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TwoSystemsEvent } from "../src/contracts.js";
import { validateEvent } from "../src/contracts.js";
import { RECEIPT_RULES, bootstrapSaving, buildReceipt, requestTokens, seededRandom } from "../src/receipt.js";

const T0 = Date.parse("2026-10-19T10:00:00Z");
let counter = 0;
const id = () => `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, "0")}`;
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function usage(session: string, minute: number, context: number, cost?: number): TwoSystemsEvent {
  const u: TwoSystemsEvent = { v: 1, id: id(), ts: at(minute), type: "usage", agent: "claude-code", session, usage: { source: "exact", input_tokens: 100, cache_read_tokens: context, output_tokens: 50, context_tokens: context } };
  if (cost !== undefined && u.type === "usage") u.usage.cost_usd = cost;
  return u;
}

function decision(session: string, minute: number, holdout: boolean, cost = 0.00002): TwoSystemsEvent & { type: "decision" } {
  return {
    v: 1,
    id: id(),
    ts: at(minute),
    type: "decision",
    agent: "claude-code",
    session,
    decision: {
      name: "fresh_start",
      engine: { kind: "openrouter", model: "microsoft/microsoft-decision-1-20261009" },
      state_hash: `sha256:${"a".repeat(64)}`,
      probabilities: { continue: 0.05, compact: 0.05, clear: 0.9 },
      suggestion: "clear",
      band: "act",
      holdout,
      cost_usd: cost,
      ...(holdout ? { reason: "holdout" } : {}),
    },
  };
}

test("requestTokens adds up every part, or falls back to the context size", () => {
  assert.equal(requestTokens({ source: "exact", input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 1 }), 116);
  assert.equal(requestTokens({ source: "estimate", context_tokens: 5000 }), 5000);
  assert.equal(requestTokens({ source: "estimate" }), 0);
});

test("the seeded bootstrap is reproducible and centred on the difference in means", () => {
  const control = [10, 12, 11, 13, 12, 10, 11, 12];
  const treated = [5, 6, 5, 7, 6, 5, 6, 5];
  const a = bootstrapSaving(control, treated, 1000, seededRandom(1));
  const b = bootstrapSaving(control, treated, 1000, seededRandom(1));
  assert.deepEqual(a, b);
  assert.equal(a.mean, 11.375 - 5.625);
  assert.ok(a.low > 0 && a.low < a.mean && a.mean < a.high);
});

test("an empty log gives an empty receipt that asks for more data", () => {
  const r = buildReceipt([]);
  assert.equal(r.decisions.total, 0);
  assert.equal(r.ownCostUsd, 0);
  assert.deepEqual(r.verified, { status: "not_enough_data", shown: 0, heldOut: 0, needed: RECEIPT_RULES.minPerGroup });
});

test("an accepted clear is estimated from the context that shrank, times the requests after it", () => {
  const d = decision("s1", 10, false);
  const events: TwoSystemsEvent[] = [
    usage("s1", 1, 150_000),
    usage("s1", 9, 160_000),
    d,
    { v: 1, id: id(), ts: at(11), type: "user_action", agent: "claude-code", session: "s1", user_action: { decision_id: d.id, action: "clear" } },
    usage("s1", 12, 20_000),
    usage("s1", 13, 25_000),
    usage("s1", 14, 30_000),
  ];
  for (const e of events) assert.deepEqual(validateEvent(e), { ok: true, errors: [] });
  const r = buildReceipt(events);
  assert.equal(r.estimatedTokensSaved, (160_000 - 20_000) * 3);
  assert.deepEqual(r.actions, { accepted: 1, declined: 0 });
  assert.equal(r.decisions.shown, 1);
  assert.equal(r.sessions, 1);
});

test("the verified figure appears only when the interval clears zero", () => {
  const events: TwoSystemsEvent[] = [];
  for (let i = 0; i < 50; i += 1) {
    // Moments two hours apart, so their hour-long windows do not overlap.
    const start = i * 120;
    if (i % 2 === 0) {
      // Held back: the session keeps its big context for the next hour.
      events.push(decision(`h${i}`, start, true), usage(`h${i}`, start + 5, 150_000, 0.05), usage(`h${i}`, start + 10, 150_000, 0.05));
    } else {
      // Shown: the user cleared, and the new session is cheap.
      events.push(decision(`s${i}`, start, false), usage(`s${i}-new`, start + 5, 20_000, 0.01), usage(`s${i}-new`, start + 10, 20_000, 0.01 + (i % 3) * 0.001));
    }
  }
  const r = buildReceipt(events);
  assert.equal(r.verified.status, "verified");
  if (r.verified.status === "verified") {
    assert.equal(r.verified.unit, "usd");
    assert.ok(r.verified.perMoment.low > 0);
    assert.ok(Math.abs(r.verified.perMoment.mean - 0.079) < 0.002, String(r.verified.perMoment.mean));
  }
  assert.ok(Math.abs(r.ownCostUsd - 50 * 0.00002) < 1e-12);

  const noEffect: TwoSystemsEvent[] = [];
  for (let i = 0; i < 50; i += 1) {
    const start = i * 120;
    const same = 0.02 + (i % 5) * 0.01;
    noEffect.push(decision(`m${i}`, start, i % 2 === 0), usage(`m${i}`, start + 5, 50_000, same));
  }
  assert.equal(buildReceipt(noEffect).verified.status, "no_clear_effect");
});

test("usage outside the hour after a moment does not count, and estimates never count as verified", () => {
  const events: TwoSystemsEvent[] = [];
  for (let i = 0; i < 40; i += 1) {
    const start = i * 200;
    events.push(decision(`m${i}`, start, i % 2 === 0), usage(`m${i}`, start + 30, 1000, 0.01));
    if (i % 2 === 0) events.push(usage(`m${i}`, start + 61, 900_000, 9));
  }
  const { verified } = buildReceipt(events);
  assert.ok(verified.status === "no_clear_effect", verified.status);
  assert.equal(verified.perMoment.mean, 0);

  const estimates: TwoSystemsEvent[] = [];
  for (let i = 0; i < 60; i += 1) {
    const d = decision(`c${i}`, i * 120, i % 2 === 0);
    estimates.push({ ...d, agent: "copilot" });
    estimates.push({ v: 1, id: id(), ts: at(i * 120 + 5), type: "usage", agent: "copilot", session: `c${i}`, usage: { source: "estimate", context_tokens: 50_000 } });
  }
  assert.deepEqual(buildReceipt(estimates).verified, { status: "not_enough_data", shown: 0, heldOut: 0, needed: RECEIPT_RULES.minPerGroup });
});

test("a clear followed by a new session is still estimated", () => {
  const d = decision("old", 10, false);
  const events: TwoSystemsEvent[] = [
    usage("old", 9, 160_000),
    d,
    { v: 1, id: id(), ts: at(11), type: "user_action", agent: "claude-code", session: "old", user_action: { decision_id: d.id, action: "clear" } },
    usage("new", 12, 15_000),
    usage("new", 13, 18_000),
  ];
  assert.equal(buildReceipt(events).estimatedTokensSaved, (160_000 - 15_000) * 2);
});

test("each suggestion counts once, and a clear is followed only into sessions it opened", () => {
  const d = decision("old", 10, false);
  const events: TwoSystemsEvent[] = [
    usage("old", 9, 160_000),
    usage("parallel", 5, 90_000),
    d,
    { v: 1, id: id(), ts: at(11), type: "user_action", agent: "claude-code", session: "old", user_action: { decision_id: d.id, action: "compact" } },
    { v: 1, id: id(), ts: at(12), type: "user_action", agent: "claude-code", session: "old", user_action: { decision_id: d.id, action: "clear" } },
    usage("parallel", 12, 90_000),
    usage("new", 13, 15_000),
    usage("new", 14, 18_000),
  ];
  const r = buildReceipt(events);
  assert.deepEqual(r.actions, { accepted: 1, declined: 0 });
  // Compact was the first answer: the old session's size before, then the first
  // request after it in the sessions that count (the new one), times two requests.
  assert.equal(r.estimatedTokensSaved, (160_000 - 15_000) * 2);
});
