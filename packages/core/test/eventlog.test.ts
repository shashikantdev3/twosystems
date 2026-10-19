// Tests for the event log and settings. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheTtlFor, readConfig } from "../src/config.js";
import type { TwoSystemsEvent } from "../src/contracts.js";
import { appendEvent, isToken, newId, readEvents, timestamp } from "../src/eventlog.js";

const event = (session = "s-1"): TwoSystemsEvent => ({
  v: 1,
  id: newId(),
  ts: timestamp(Date.parse("2026-10-19T10:00:00Z")),
  type: "usage",
  agent: "copilot",
  session,
  usage: { source: "estimate", context_tokens: 1234 },
});

test("events are appended one per line and read back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-log-"));
  const path = join(dir, "nested", "events.jsonl");
  await appendEvent(path, event("a"));
  await appendEvent(path, event("b"));
  const text = await readFile(path, "utf8");
  assert.equal(text.split("\n").length, 3);
  const { events, problems } = await readEvents(path);
  assert.deepEqual(events.map((e) => e.session), ["a", "b"]);
  assert.deepEqual(problems, []);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("an invalid event is refused before anything is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-log-"));
  const path = join(dir, "events.jsonl");
  const bad = { ...event(), session: "has spaces" } as TwoSystemsEvent;
  await assert.rejects(appendEvent(path, bad), /Refusing to write an invalid event: \/session does not have the expected format/);
  assert.deepEqual(await readEvents(path), { events: [], problems: [] });
});

test("reading skips bad lines, handles CRLF and a BOM, and survives a huge line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-log-"));
  const path = join(dir, "events.jsonl");
  const good = JSON.stringify(event());
  await writeFile(path, `﻿${good}\r\nnot json\r\n\r\n${"x".repeat(200_000)}\n${good}`);
  const { events, problems } = await readEvents(path);
  assert.equal(events.length, 2);
  assert.deepEqual(problems, ["line 2: not valid JSON", "line 4: longer than 16384 bytes"]);
});

test("tokens, ids and timestamps fit the schema", () => {
  assert.ok(isToken("microsoft/microsoft-decision-1-20261009"));
  assert.ok(!isToken("has space"));
  assert.ok(!isToken(""));
  assert.match(newId(), /^[0-9a-f-]{36}$/);
  assert.equal(timestamp(0), "1970-01-01T00:00:00.000Z");
});

test("settings come from the environment with safe defaults", () => {
  const plain = readConfig({ HOME: "/home/u" });
  assert.equal(plain.engine, "rules");
  assert.equal(plain.holdoutRate, 0.1);
  assert.equal(plain.timeoutMs, 3000);
  assert.equal(cacheTtlFor(plain, "claude-code"), 3600);
  assert.equal(cacheTtlFor(plain, "copilot"), 300);
  assert.deepEqual(plain.warnings, []);

  const keyed = readConfig({ OPENROUTER_API_KEY: " k ", TWOSYSTEMS_HOME: "/data", TWOSYSTEMS_CACHE_TTL_S: "600" });
  assert.equal(keyed.engine, "openrouter");
  assert.equal(keyed.openRouterKey, "k");
  assert.equal(keyed.eventsPath, join("/data", "events.jsonl"));
  assert.equal(cacheTtlFor(keyed, "claude-code"), 600);

  const bad = readConfig({ TWOSYSTEMS_ENGINE: "magic", TWOSYSTEMS_HOLDOUT: "0.9", TWOSYSTEMS_MODEL: "bad model" });
  assert.equal(bad.engine, "rules");
  assert.equal(bad.holdoutRate, 0.1);
  assert.equal(bad.model, undefined);
  assert.equal(bad.warnings.length, 3);
  assert.ok(bad.warnings.every((w) => !w.includes("magic") && !w.includes("0.9")));
});
