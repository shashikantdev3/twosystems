// Tests for the shared record builders and observation helpers.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvent } from "../src/contracts.js";
import { OBSERVATION_LIMITS, rememberIn, toolCommand, toolFiles } from "../src/observations.js";
import { exactUsageRecord, userActionRecord } from "../src/records.js";
import type { Observation } from "../src/signals.js";

const source = { agent: "claude-code" as const, session: "7f9c2a1e-0d3b-4c55-9a77-1b2c3d4e5f60", adapterVersion: "0.1.0-alpha.3" };

test("an exact usage record fits the schema and adds up the context", () => {
  const record = exactUsageRecord(source, Date.parse("2026-10-19T10:00:00Z"), {
    model: "claude-opus-5-5",
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 90_000,
    cacheWriteTokens: 800,
  });
  assert.deepEqual(validateEvent(record), { ok: true, errors: [] });
  assert.equal(record.usage.context_tokens, 92_000);
  assert.equal(record.usage.source, "exact");
  assert.equal(record.adapter_version, "0.1.0-alpha.3");
});

test("bad numbers and names are left out rather than written", () => {
  const record = exactUsageRecord({ ...source, session: "has spaces and more" }, 0, {
    model: "has space",
    requestId: "req 1",
    inputTokens: -5,
    outputTokens: Number.NaN,
    cacheReadTokens: 10.6,
    costUsd: -1,
  });
  assert.deepEqual(validateEvent(record), { ok: true, errors: [] });
  assert.equal(record.usage.model, undefined);
  assert.equal(record.usage.request_id, undefined);
  assert.equal(record.usage.input_tokens, undefined);
  assert.equal(record.usage.cache_read_tokens, 11);
  assert.equal(record.usage.context_tokens, 11);
  assert.match(record.session, /^s-[0-9a-f]{16}$/);
});

test("a user action record fits the schema", () => {
  const record = userActionRecord(source, 0, "3b241101-e2bb-4255-8caf-4136c566a962", "keep_going");
  assert.deepEqual(validateEvent(record), { ok: true, errors: [] });
  assert.deepEqual(record.user_action, { decision_id: "3b241101-e2bb-4255-8caf-4136c566a962", action: "keep_going" });
});

test("tool calls give their command and edited files", () => {
  assert.equal(toolCommand({ command: "npm test" }), "npm test");
  assert.equal(toolCommand({ file_path: "a.ts" }), undefined);
  assert.deepEqual(toolFiles("Edit", { file_path: "src/a.ts" }), ["src/a.ts"]);
  assert.deepEqual(toolFiles("Write", {}), ["(unnamed file)"]);
  assert.equal(toolFiles("Read", { file_path: "src/a.ts" }), undefined);
  assert.equal(toolFiles("mcp__x__write_file", { path: "a" }), undefined);
});

test("remembered observations are redacted, in time order and capped", () => {
  const list: Observation[] = [];
  rememberIn(list, { kind: "prompt", at: 5, text: "deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
  rememberIn(list, { kind: "prompt", at: 1, text: "first" });
  assert.deepEqual(
    list.map((o) => o.at),
    [1, 5],
  );
  assert.ok(list[1]?.kind === "prompt" && !list[1].text.includes("ghp_"));
  for (let i = 0; i < 200; i++) rememberIn(list, { kind: "tool", at: 10 + i, tool: "Bash", ok: true });
  assert.equal(list.length, OBSERVATION_LIMITS.observations);
  assert.equal(list.at(-1)?.at, 209);
});
