// Tests for the rule signals. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Observation,
  SIGNAL_RULES,
  contentWords,
  errorFingerprint,
  freshStartSignals,
  normalizeCommand,
  promptOverlap,
  stuckSignals,
} from "../src/signals.js";

const T0 = Date.parse("2026-10-19T10:00:00Z");

function failing(n: number, command: string, error: string, start = 0): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "tool" as const,
    at: T0 + (start + i) * 1000,
    tool: "bash",
    command,
    ok: false,
    error,
  }));
}

test("errors that differ only in numbers, paths and quoted text share a fingerprint", () => {
  const a = errorFingerprint("TypeError: Cannot read 'id' of undefined at /home/a/src/x.ts:12:5");
  const b = errorFingerprint("TypeError: Cannot read 'name' of undefined at /home/b/src/y.ts:40:9");
  assert.equal(a, b);
  assert.notEqual(a, errorFingerprint("SyntaxError: Unexpected token"));
  assert.equal(errorFingerprint("\n\n  first line\nsecond"), "first line");
});

test("generic exit lines are skipped so different errors stay different", () => {
  const a = errorFingerprint("Exit code 1\nTypeError: x is not a function");
  const b = errorFingerprint("Exit code 1\nModuleNotFoundError: No module named 'y'");
  assert.notEqual(a, b);
  assert.equal(a, "typeerror: x is not a function");
  assert.equal(
    errorFingerprint("Traceback (most recent call last):\n  File \"/a/b.py\", line 3, in <module>\nKeyError: 'token'"),
    errorFingerprint("Traceback (most recent call last):\n  File \"/c/d.py\", line 9, in main\nKeyError: 'name'"),
  );
  assert.equal(errorFingerprint("Exit code 2"), "exit code <n>");
});

test("commands compare equal after whitespace is collapsed", () => {
  assert.equal(normalizeCommand("  npm   test \n"), "npm test");
});

test("the same failing command three times is a repeated command and a repeated error", () => {
  const obs: Observation[] = [{ kind: "prompt", at: T0, text: "fix the login test" }, ...failing(3, "npm test", "AssertionError: expected 200, got 500")];
  assert.deepEqual(stuckSignals(obs), ["repeated_command", "repeated_error"]);
});

test("two failures are not enough, and a prompt resets the count", () => {
  assert.deepEqual(stuckSignals(failing(2, "npm test", "boom")), []);
  const obs: Observation[] = [...failing(5, "npm test", "boom"), { kind: "prompt", at: T0 + 10_000, text: "try another way" }];
  assert.deepEqual(stuckSignals(obs), []);
});

test("only the recent window counts towards repeats", () => {
  const old = failing(2, "npm test", "boom");
  const fresh = Array.from({ length: SIGNAL_RULES.window - 1 }, (_, i) => ({
    kind: "tool" as const,
    at: T0 + (10 + i) * 1000,
    tool: "edit",
    ok: true,
    files: [`f${i}.ts`],
  }));
  const last = failing(1, "npm test", "boom", 30);
  assert.deepEqual(stuckSignals([...old, ...fresh, ...last]), []);
});

test("ten calls without a changed file is no_file_change; forty calls is many_tool_calls", () => {
  const reads = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ kind: "tool" as const, at: T0 + i, tool: "read", ok: true }));
  assert.deepEqual(stuckSignals(reads(9)), []);
  assert.deepEqual(stuckSignals(reads(10)), ["no_file_change"]);
  assert.deepEqual(stuckSignals(reads(40)), ["no_file_change", "many_tool_calls"]);
});

test("prompt overlap measures shared content words", () => {
  assert.deepEqual([...contentWords("Fix the LOGIN test, please!")].sort(), ["fix", "login", "test"]);
  assert.equal(promptOverlap("fix the login test again", ["fix login test"]), 1);
  assert.equal(promptOverlap("write a haiku about autumn leaves", ["fix login test"]), 0);
  assert.equal(promptOverlap("", ["anything"]), 1);
});

function session(contextTokens: number, window?: number): Observation[] {
  const obs: Observation[] = [
    { kind: "prompt", at: T0, text: "Refactor the payment service to use the new billing client" },
    { kind: "tool", at: T0 + 1000, tool: "edit", ok: true, files: ["billing.ts"] },
  ];
  obs.push(window === undefined ? { kind: "context", at: T0 + 2000, tokens: contextTokens } : { kind: "context", at: T0 + 2000, tokens: contextTokens, window });
  return obs;
}

test("fresh start signals need a context worth clearing", () => {
  const input = { observations: session(10_000), prompt: "Write release notes for the mobile app", now: T0 + 3_600_000, cacheTtlSeconds: 300 };
  assert.deepEqual(freshStartSignals(input), []);
});

test("large context, expired cache and a new topic each fire", () => {
  const now = T0 + 10 * 60_000;
  const signals = freshStartSignals({
    observations: session(120_000, 200_000),
    prompt: "Write release notes for the mobile app store listing",
    now,
    cacheTtlSeconds: 300,
  });
  assert.deepEqual(signals, ["large_context", "cache_expired", "new_prompt_low_overlap"]);
});

test("a follow-up prompt on the same topic inside the cache lifetime only reports size", () => {
  const signals = freshStartSignals({
    observations: session(150_000),
    prompt: "Now add retries to the billing client in the payment service",
    now: T0 + 60_000,
    cacheTtlSeconds: 300,
  });
  assert.deepEqual(signals, ["large_context"]);
});

test("short prompts are not judged for topic changes", () => {
  const signals = freshStartSignals({ observations: session(50_000, 200_000), prompt: "ok continue", now: T0 + 60_000, cacheTtlSeconds: 300 });
  assert.deepEqual(signals, []);
});
