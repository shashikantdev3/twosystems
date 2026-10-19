// Replay test: recorded hook sessions run through the whole hook path with the
// rules engine, as the twosystems command would run them. Every event written
// must pass the schema, the replies must come at the expected steps, and no
// text from the sessions may reach the event log.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import type { Agent } from "../src/contracts.js";
import { validateEventsJsonl } from "../src/contracts.js";
import { RulesEngine } from "../src/engines/rules.js";
import { handleHook, recordEvents } from "../src/hookrunner.js";
import { builtInLock } from "../src/lock.js";

interface Step {
  note?: string;
  event?: string;
  payload: Record<string, unknown>;
  expect: "none" | "ask" | "note";
}
interface Fixture {
  description: string;
  agent: Agent;
  transcript?: unknown[];
  steps: Step[];
  expect_events: string[];
  expect_user_actions: string[];
  expect_decision?: { name: string; band: string; suggestion: string; signals: string[] };
}

const dir = new URL("../../test/fixtures/sessions/", import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

test("there are recorded sessions to replay", () => {
  assert.ok(files.length >= 4);
});

function kindOf(output: Record<string, unknown>): Step["expect"] {
  if (Object.keys(output).length === 0) return "none";
  if (typeof output["systemMessage"] === "string") return "note";
  const specific = output["hookSpecificOutput"] as Record<string, unknown> | undefined;
  if (output["permissionDecision"] === "ask" || specific?.["permissionDecision"] === "ask") return "ask";
  return "none";
}

for (const file of files) {
  test(`replay ${file}`, async () => {
    const fixture = JSON.parse(await readFile(new URL(file, dir), "utf8")) as Fixture;
    const home = await mkdtemp(join(tmpdir(), "twosystems-replay-"));
    const config = readConfig({ TWOSYSTEMS_HOME: home });
    const transcript = join(home, "transcript.jsonl");
    await writeFile(transcript, (fixture.transcript ?? []).map((l) => JSON.stringify(l)).join("\n"));
    const engine = new RulesEngine();
    const lock = builtInLock(engine.info);

    let now = Date.parse("2026-10-19T10:00:00Z");
    const replies: Step["expect"][] = [];
    for (const step of fixture.steps) {
      now += 1000;
      const payload = JSON.parse(JSON.stringify(step.payload).replaceAll('"TRANSCRIPT"', JSON.stringify(transcript)));
      const result = await handleHook(payload, step.event, {
        config,
        engine,
        lock,
        agent: fixture.agent,
        adapterVersion: "0.1.0-alpha.1",
        now,
        random: () => 0.5,
      });
      await recordEvents(config.eventsPath, result.events);
      replies.push(kindOf(result.output));
    }
    assert.deepEqual(replies, fixture.steps.map((s) => s.expect), "replies at each step");

    const log = await readFile(config.eventsPath, "utf8").catch(() => "");
    const check = validateEventsJsonl(log);
    assert.deepEqual(check.errors, []);
    const events = log.trim() === "" ? [] : log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual([...new Set(events.map((e) => e["type"] as string))].sort(), [...fixture.expect_events].sort());
    const actions = events.filter((e) => e["type"] === "user_action").map((e) => (e["user_action"] as { action: string }).action);
    assert.deepEqual(actions, fixture.expect_user_actions);
    const expected = fixture.expect_decision;
    if (expected !== undefined) {
      const made = events.filter((e) => e["type"] === "decision").map((e) => e["decision"] as Record<string, unknown>);
      assert.ok(
        made.some(
          (d) =>
            d["name"] === expected.name &&
            d["band"] === expected.band &&
            d["suggestion"] === expected.suggestion &&
            JSON.stringify(d["signals"]) === JSON.stringify(expected.signals),
        ),
        JSON.stringify(made),
      );
    }

    // Privacy: no prompt, command or error text from the session reaches the event log.
    for (const step of fixture.steps) {
      for (const key of ["prompt", "error"]) {
        const text = step.payload[key];
        if (typeof text === "string") assert.ok(!log.includes(text.slice(0, 20)), `"${key}" text leaked into the event log`);
      }
    }
    assert.ok(!log.includes("npm test") && !log.includes("pytest"), "a command leaked into the event log");
  });
}
