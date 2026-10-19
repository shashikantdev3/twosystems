// Tests for what a hook call does across a session. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import type { Agent, TwoSystemsEvent } from "../src/contracts.js";
import { RulesEngine } from "../src/engines/rules.js";
import type { DecisionEngine } from "../src/engines/types.js";
import { type HookResult, handleHook } from "../src/hookrunner.js";
import { builtInLock } from "../src/lock.js";
import { loadNotes } from "../src/sessions.js";

const T0 = Date.parse("2026-10-19T10:00:00Z");

/** The rules engine, counting how often it is asked. */
class CountingEngine implements DecisionEngine {
  readonly info = { kind: "rules" as const };
  readonly remote = false;
  calls = 0;
  private readonly inner = new RulesEngine();
  decide(request: Parameters<RulesEngine["decide"]>[0]) {
    this.calls += 1;
    return this.inner.decide(request);
  }
}

async function harness(agent: Agent = "claude-code") {
  const home = await mkdtemp(join(tmpdir(), "twosystems-runner-"));
  const config = readConfig({ TWOSYSTEMS_HOME: home });
  const engine = new CountingEngine();
  const events: TwoSystemsEvent[] = [];
  let clock = T0;
  const send = async (payload: Record<string, unknown>, at?: number): Promise<HookResult> => {
    clock = at ?? clock + 1000;
    const result = await handleHook(payload, undefined, {
      config,
      engine,
      lock: builtInLock(engine.info),
      agent,
      adapterVersion: "test",
      now: clock,
      random: () => 0.5,
    });
    events.push(...result.events);
    return result;
  };
  return { config, engine, events, send };
}

const asks = (r: HookResult) =>
  (r.output["hookSpecificOutput"] as { permissionDecision?: string } | undefined)?.permissionDecision === "ask";

test("after the user lets a step run, old failures do not trigger the question again", async () => {
  const { send, events } = await harness();
  const s = { session_id: "a", cwd: "/w" };
  await send({ ...s, hook_event_name: "UserPromptSubmit", prompt: "fix the failing test" });
  for (let i = 0; i < 3; i += 1) {
    await send({ ...s, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `f${i}`, tool_input: { command: "npm test" } });
    await send({ ...s, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: `f${i}`, tool_input: { command: "npm test" }, error: "AssertionError: 500" });
  }
  assert.ok(asks(await send({ ...s, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "f3", tool_input: { command: "npm test" } })));
  await send({ ...s, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "f3", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
  const later: boolean[] = [];
  for (let i = 0; i < 8; i += 1) {
    later.push(asks(await send({ ...s, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: `e${i}`, tool_input: { file_path: `f${i}.ts` } })));
    await send({ ...s, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: `e${i}`, tool_input: { file_path: `f${i}.ts` }, tool_response: { success: true } });
  }
  assert.deepEqual(later, Array(8).fill(false));
  const actions = events.filter((e) => e.type === "user_action").map((e) => (e.type === "user_action" ? e.user_action.action : ""));
  assert.deepEqual(actions, ["keep_going"]);
});

test("Copilot gets no fresh-start check in the alpha, because the note may never be shown", async () => {
  const { send, engine, events } = await harness("copilot");
  const s = { session_id: "cli", cwd: "/w" };
  await send({ ...s, hook_event_name: "UserPromptSubmit", prompt: "Refactor the billing client in the payment service", timestamp: T0 }, T0);
  for (let i = 0; i < 400; i += 1) {
    await send({ ...s, hook_event_name: "PostToolUse", tool_name: "edit", tool_input: { path: `f${i}` }, tool_response: { resultType: "success" }, timestamp: T0 + i }, T0 + i);
  }
  const r = await send({ ...s, hook_event_name: "UserPromptSubmit", prompt: "Write release notes for the Android app store listing", timestamp: T0 + 7_200_000 }, T0 + 7_200_000);
  assert.deepEqual(r.output, {});
  assert.equal(engine.calls, 0);
  assert.ok(events.every((e) => e.type !== "decision"));
  // The same with ISO timestamps, as the Copilot CLI sends for PascalCase hook names.
  const iso = await send({ ...s, hook_event_name: "UserPromptSubmit", prompt: "Now plan the database migration for orders", timestamp: "2026-10-19T14:00:00Z" });
  assert.deepEqual(iso.output, {});
  assert.equal(engine.calls, 0);
});

function bigSession(send: Awaited<ReturnType<typeof harness>>["send"], session: string, cwd: string) {
  return send({ session_id: session, cwd, hook_event_name: "SessionStart", source: "resume", context_tokens: 150_000, prompt_cache_likely_expired: true });
}

test("a resumed session whose cache has expired gets the cache signal on the next prompt", async () => {
  const { send, events } = await harness();
  await bigSession(send, "r", "/w");
  const r = await send({ session_id: "r", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt: "continue with the billing work please" });
  const decision = events.find((e) => e.type === "decision");
  assert.ok(decision?.type === "decision");
  assert.deepEqual(decision.decision.signals, ["large_context", "cache_expired"]);
  assert.equal(decision.decision.suggestion, "compact");
  assert.equal(typeof r.output["systemMessage"], "string");
});

test("only a manual compact counts as taking a compact suggestion", async () => {
  const { send, events } = await harness();
  await bigSession(send, "c", "/w");
  await send({ session_id: "c", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt: "continue with the billing work please" });
  await send({ session_id: "c", cwd: "/w", hook_event_name: "PreCompact", trigger: "auto" });
  await send({ session_id: "c", cwd: "/w", hook_event_name: "SessionStart", source: "compact" });
  assert.equal(events.filter((e) => e.type === "user_action").length, 0);
  await send({ session_id: "c", cwd: "/w", hook_event_name: "PreCompact", trigger: "manual" });
  const actions = events.filter((e) => e.type === "user_action");
  assert.equal(actions.length, 1);
  assert.ok(actions[0]?.type === "user_action" && actions[0].user_action.action === "compact");
});

test("a clear is linked to the suggestion from the same project folder only", async () => {
  const { send, events } = await harness();
  await send({ session_id: "old", cwd: "/w", hook_event_name: "SessionStart", source: "resume", context_tokens: 150_000 });
  await send({ session_id: "old", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt: "Refactor the payment service billing client" });
  const r = await send({ session_id: "old", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt: "Write release notes for the Android app store listing" });
  assert.match(String(r.output["systemMessage"]), /\/clear/);
  await send({ session_id: "other", cwd: "/elsewhere", hook_event_name: "SessionStart", source: "clear" });
  assert.equal(events.filter((e) => e.type === "user_action").length, 0);
  await send({ session_id: "new", cwd: "/w", hook_event_name: "SessionStart", source: "clear" });
  const action = events.find((e) => e.type === "user_action");
  assert.ok(action?.type === "user_action");
  assert.equal(action.user_action.action, "clear");
  assert.equal(action.session, "old");
});

test("a stop after a long turn records the size the transcript reports", async () => {
  const { send, config } = await harness();
  const { writeFile } = await import("node:fs/promises");
  const transcript = join(config.home, "t.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({ type: "assistant", requestId: "req_7", timestamp: "2026-10-19T09:59:00Z", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 70_000, output_tokens: 5 } } })}\n`,
  );
  const r = await send({ session_id: "t", cwd: "/w", hook_event_name: "Stop", transcript_path: transcript });
  assert.equal(r.events.length, 1);
  assert.ok(r.events[0]?.type === "usage" && r.events[0].usage.context_tokens === 70_010);
  const notes = await loadNotes(config.sessionsDir, "claude-code", "t");
  assert.deepEqual(notes.observations, [{ kind: "context", at: Date.parse("2026-10-19T09:59:00Z"), tokens: 70_010 }]);
  // The same request is not logged twice.
  assert.equal((await send({ session_id: "t", cwd: "/w", hook_event_name: "Stop", transcript_path: transcript })).events.length, 0);
});

test("two stuck checks started at once make only one model call", async () => {
  const { send, engine } = await harness();
  const s = { session_id: "par", cwd: "/w" };
  await send({ ...s, hook_event_name: "UserPromptSubmit", prompt: "fix the failing test" });
  for (let i = 0; i < 3; i += 1) {
    await send({ ...s, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: `f${i}`, tool_input: { command: "npm test" }, error: "AssertionError: 500" });
  }
  const results = await Promise.all([
    send({ ...s, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a", tool_input: { command: "npm test" } }),
    send({ ...s, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "b", tool_input: { file_path: "x" } }),
  ]);
  assert.equal(engine.calls, 1);
  assert.equal(results.filter(asks).length, 1);
});
