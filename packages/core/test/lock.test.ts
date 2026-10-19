// Tests for decisions.lock handling and thresholds. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLock } from "../src/contracts.js";
import { applyThresholds, builtInLock, defaultLock, lockMismatch, readLock } from "../src/lock.js";
import { QUESTIONS, questionHash } from "../src/questions.js";

test("the built-in locks are valid decisions.lock files", () => {
  for (const engine of [{ kind: "rules" as const }, { kind: "openrouter" as const, model: "microsoft/microsoft-decision-1-20261009" }]) {
    const lock = defaultLock(engine);
    assert.deepEqual(validateLock(lock), { ok: true, errors: [] });
    assert.equal(lock.decisions.stuck?.question_hash, questionHash(QUESTIONS.stuck));
  }
});

test("question hashes are stable and differ between questions", () => {
  assert.match(questionHash(QUESTIONS.stuck), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(questionHash(QUESTIONS.stuck), questionHash(QUESTIONS.fresh_start));
  assert.equal(questionHash(QUESTIONS.stuck), questionHash({ ...QUESTIONS.stuck }));
});

test("bands follow act, then unsure, then silent", () => {
  const t = { clear: { act: 0.85, unsure: 0.6 }, compact: { act: 0.9, unsure: 0.7 } };
  assert.deepEqual(applyThresholds({ continue: 0.05, compact: 0.05, clear: 0.9 }, t), { band: "act", suggestion: "clear" });
  assert.deepEqual(applyThresholds({ continue: 0.3, compact: 0.0, clear: 0.7 }, t), { band: "unsure", suggestion: "clear" });
  assert.deepEqual(applyThresholds({ continue: 0.5, compact: 0.3, clear: 0.2 }, t), { band: "silent" });
  // Compact reaches its unsure threshold while clear does not: compact wins.
  assert.deepEqual(applyThresholds({ continue: 0.1, compact: 0.75, clear: 0.15 }, t), { band: "unsure", suggestion: "compact" });
  // A label without a suggestion never triggers a band.
  assert.deepEqual(applyThresholds({ progressing: 1, stuck: 0 }, { progressing: { act: 0.5, unsure: 0.1 } }), { band: "silent" });
  assert.deepEqual(applyThresholds({ progressing: 0.05, stuck: 0.95 }, { stuck: { act: 0.9, unsure: 0.7 } }), { band: "act", suggestion: "pause" });
});

test("a lock entry is used only for the same engine and the same question", () => {
  const engine = { kind: "openrouter" as const, model: "m1" };
  const entry = defaultLock(engine).decisions.stuck;
  assert.equal(lockMismatch(entry, "stuck", engine), null);
  assert.equal(lockMismatch(entry, "stuck", { kind: "openrouter", model: "m2" }), "engine");
  assert.equal(lockMismatch(entry, "fresh_start", engine), "question");
  assert.equal(lockMismatch(undefined, "stuck", engine), "missing");
});

test("readLock returns null for a missing file, a lock for a valid one, and throws for a bad one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-lock-"));
  assert.equal(await readLock(join(dir, "none.lock")), null);
  const good = join(dir, "good.lock");
  const lock = builtInLock({ kind: "rules" }).lock;
  await writeFile(good, `﻿${JSON.stringify(lock, null, 2)}`);
  const loaded = await readLock(good);
  assert.equal(loaded?.source, good);
  assert.equal(loaded?.hash, builtInLock({ kind: "rules" }).hash);
  const bad = join(dir, "bad.lock");
  await writeFile(bad, JSON.stringify({ ...lock, holdout_rate: 2 }));
  await assert.rejects(readLock(bad), /not a valid decisions.lock: \/holdout_rate must be <= 0.5/);
});
