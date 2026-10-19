// Tests for session notes. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_LIMITS,
  loadNotes,
  pruneNotes,
  remember,
  savePendingClear,
  shorten,
  storable,
  takePendingClear,
  updateNotes,
} from "../src/sessions.js";

const T0 = Date.parse("2026-10-19T10:00:00Z");
const fakeKey = ["sk-", "or-v1-", "0123456789abcdef".repeat(4)].join("");

test("stored text is redacted and shortened, and keeps its line breaks", () => {
  const long = `line one\nline two ${"x".repeat(1000)}`;
  const short = shorten(long);
  assert.ok(short.length <= SESSION_LIMITS.textChars);
  assert.ok(short.startsWith("line one\nline two"));
  const tool = storable({ kind: "tool", at: T0, tool: "Bash", command: `export KEY=${fakeKey}`, ok: false, error: `bad key ${fakeKey}` });
  assert.ok(!JSON.stringify(tool).includes(fakeKey));
  const prompt = storable({ kind: "prompt", at: T0, text: `use ${fakeKey}` });
  assert.ok(prompt.kind === "prompt" && !prompt.text.includes(fakeKey));
});

test("notes start empty, keep the latest observations in time order, and survive damage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-notes-"));
  const empty = await loadNotes(dir, "claude-code", "s1");
  assert.deepEqual(empty, { v: 1, agent: "claude-code", session: "s1", observations: [], toolCalls: 0, estimatedTokens: 0 });
  await updateNotes(dir, "claude-code", "s1", (notes) => {
    for (let i = 0; i < SESSION_LIMITS.observations + 20; i += 1) remember(notes, { kind: "prompt", at: T0 + (100 - i) * 1000, text: `p${i}` });
  });
  const saved = await loadNotes(dir, "claude-code", "s1");
  assert.equal(saved.observations.length, SESSION_LIMITS.observations);
  const times = saved.observations.map((o) => o.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const [file] = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  assert.ok(file !== undefined);
  if (process.platform !== "win32") assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
  await writeFile(join(dir, file), "{ damaged");
  assert.equal((await loadNotes(dir, "claude-code", "s1")).observations.length, 0);
});

test("parallel changes to the same notes are not lost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-notes-"));
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      updateNotes(dir, "copilot", "busy", (notes) => {
        notes.toolCalls += 1;
        remember(notes, { kind: "tool", at: T0 + i, tool: "bash", ok: true });
      }),
    ),
  );
  const notes = await loadNotes(dir, "copilot", "busy");
  assert.equal(notes.toolCalls, 25);
  assert.equal(notes.observations.length, 25);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp")), []);
});

test("a lock left behind by a dead hook is taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-notes-"));
  await updateNotes(dir, "codex", "s", () => undefined);
  const [file] = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const lock = join(dir, `${file ?? ""}.lock`);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(lock);
  const old = (Date.now() - 60_000) / 1000;
  await utimes(lock, old, old);
  const started = Date.now();
  await updateNotes(dir, "codex", "s", (notes) => {
    notes.toolCalls = 7;
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal((await loadNotes(dir, "codex", "s")).toolCalls, 7);
});

test("a pending clear is found by agent and folder, once, and only while recent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-notes-"));
  const pending = { decisionId: "d1", agent: "claude-code", session: "old", suggestion: "clear" as const, at: T0 };
  await savePendingClear(dir, "/work/a", pending);
  assert.equal(await takePendingClear(dir, "claude-code", "/work/b", T0 + 1000, 60_000), null);
  assert.equal(await takePendingClear(dir, "copilot", "/work/a", T0 + 1000, 60_000), null);
  assert.deepEqual(await takePendingClear(dir, "claude-code", "/work/a", T0 + 1000, 60_000), pending);
  assert.equal(await takePendingClear(dir, "claude-code", "/work/a", T0 + 1000, 60_000), null);
  await savePendingClear(dir, "/work/a", pending);
  assert.equal(await takePendingClear(dir, "claude-code", "/work/a", T0 + 120_000, 60_000), null);
});

test("old notes are pruned at most once a day", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-notes-"));
  const now = Date.now();
  const stale = join(dir, "stale.json");
  const fresh = join(dir, "fresh.json");
  await writeFile(stale, "{}");
  await writeFile(fresh, "{}");
  const eightDays = (now - 8 * 86_400_000) / 1000;
  await utimes(stale, eightDays, eightDays);
  await pruneNotes(dir, now);
  assert.deepEqual((await readdir(dir)).sort(), [".last-prune", "fresh.json"]);
  await writeFile(stale, "{}");
  await utimes(stale, eightDays, eightDays);
  await pruneNotes(dir, now + 3_600_000);
  assert.ok((await readdir(dir)).includes("stale.json"), "pruned twice in a day");
});
