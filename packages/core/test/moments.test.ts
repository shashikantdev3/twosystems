// Tests for calibration moments: reading saved Claude Code sessions, finding
// the moments a live check would have judged, keeping moments.jsonl, scoring.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { main } from "../src/cli.js";
import { validateMoment, validateMomentText } from "../src/contracts.js";
import type { DecisionEngine } from "../src/engines/types.js";
import { RulesEngine } from "../src/engines/rules.js";
import { applyThresholds } from "../src/lock.js";
import type { Moment } from "../src/model.js";
import { MOMENT_RULES, dropCopies, findMoments, mergeMoments, mergeOntoDisk, momentId } from "../src/moments.js";
import {
  MOMENTS_LOCK,
  MomentsFileError,
  findSessionFiles,
  momentsFromSession,
  readMomentsFile,
  scoreMoments,
  updateMomentsFile,
  withMomentsLock,
  writeMomentsFile,
} from "../src/momentsio.js";
import { rememberIn } from "../src/observations.js";
import { QUESTIONS, questionHash } from "../src/questions.js";
import { type Observation, freshStartSignals } from "../src/signals.js";
import { buildState } from "../src/state.js";
import { inferWindow, readTimeline, sessionOf } from "../src/transcript.js";
import { clip, wellFormed } from "../src/redact.js";
import { isWellFormed } from "../src/contracts.js";

const SESSION = "7f9c2a1e-0d3b-4c55-9a77-1b2c3d4e5f60";
const T0 = Date.parse("2026-10-18T09:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const OPTIONS = { agent: "claude-code" as const, session: SESSION, cacheTtlSeconds: 3600 };
const examples = new URL("../../../../schemas/examples/", import.meta.url);

/** A small builder for Claude Code transcript lines, in the shape Claude Code writes them. */
class Session {
  readonly lines: Record<string, unknown>[] = [];
  private clock = 0;
  private calls = 0;
  private requests = 0;

  private base(type: string, extra: Record<string, unknown> = {}) {
    this.clock += 10;
    return { type, sessionId: SESSION, timestamp: at(this.clock), isSidechain: false, ...extra };
  }

  prompt(text: string, extra: Record<string, unknown> = {}): this {
    this.lines.push(this.base("user", { origin: { kind: "human" }, message: { role: "user", content: text }, ...extra }));
    return this;
  }

  /** One model request: its usage and one tool call, then the tool's result. */
  tool(name: string, input: Record<string, unknown>, result: { error?: string; text?: string } = {}, tokens = 30_000): this {
    this.calls += 1;
    this.requests += 1;
    const id = `toolu_${this.calls}`;
    this.lines.push(
      this.base("assistant", {
        requestId: `req_${this.requests}`,
        message: {
          role: "assistant",
          usage: { input_tokens: 2_000, cache_read_input_tokens: tokens - 2_000, cache_creation_input_tokens: 0, output_tokens: 100 },
          content: [{ type: "tool_use", id, name, input }],
        },
      }),
    );
    this.lines.push(
      this.base("user", {
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, is_error: result.error !== undefined, content: result.error ?? result.text ?? "ok" }],
        },
      }),
    );
    return this;
  }

  failing(times: number): this {
    for (let i = 0; i < times; i += 1) this.tool("Bash", { command: "npm test -- cart" }, { error: "FAIL src/cart.test.ts\nAssertionError: expected 2 to equal 3" });
    return this;
  }

  /** The agent's closing answer: one model request with text only. */
  answer(tokens = 30_000): this {
    this.requests += 1;
    this.lines.push(
      this.base("assistant", {
        requestId: `req_${this.requests}`,
        message: {
          role: "assistant",
          usage: { input_tokens: 2_000, cache_read_input_tokens: tokens - 2_000, cache_creation_input_tokens: 0, output_tokens: 100 },
          content: [{ type: "text", text: "Done." }],
        },
      }),
    );
    return this;
  }

  /** A slash command the person typed, such as /compact. */
  command(name: string): this {
    this.lines.push(this.base("user", { message: { role: "user", content: `<command-name>/${name}</command-name>` } }));
    return this;
  }

  compact(): this {
    this.lines.push(this.base("system", { subtype: "compact_boundary" }));
    return this;
  }

  interrupt(): this {
    this.lines.push(this.base("user", { message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    return this;
  }

  wait(seconds: number): this {
    this.clock += seconds;
    return this;
  }

  /** The time of the last line, in milliseconds. */
  get now(): number {
    return T0 + this.clock * 1000;
  }
}

test("a timeline keeps typed prompts, tool calls with their results, request sizes and compactions", () => {
  const s = new Session()
    .prompt("<system-reminder>The user's timezone is UTC.</system-reminder>make the cart tests pass")
    .tool("Bash", { command: "npm test" }, { error: "boom" });
  s.lines.push({ type: "user", sessionId: SESSION, timestamp: at(500), isMeta: true, message: { role: "user", content: "Stop hook feedback: commit" } });
  s.lines.push({ type: "user", sessionId: SESSION, timestamp: at(510), message: { role: "user", content: "<command-name>/clear</command-name>" } });
  s.lines.push({
    type: "user",
    sessionId: SESSION,
    timestamp: at(520),
    origin: { kind: "task-notification" },
    message: { role: "user", content: "<task-notification>done</task-notification>" },
  });
  s.lines.push({ type: "assistant", sessionId: SESSION, timestamp: at(530), isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } });
  s.lines.push({ type: "system", subtype: "compact_boundary", sessionId: SESSION, timestamp: at(540) });
  s.lines.push({ type: "user", sessionId: SESSION, timestamp: "not a time", message: { role: "user", content: "lost" } });
  // The same request split over two lines is counted once.
  s.lines.push({ type: "assistant", sessionId: SESSION, timestamp: at(550), requestId: "req_1", message: { role: "assistant", usage: { input_tokens: 9 } } });

  const timeline = readTimeline(s.lines);
  assert.deepEqual(
    timeline.map((e) => e.kind),
    ["prompt", "context", "tool_use", "tool_result", "turn_end", "compact", "turn_end"],
  );
  // A typed command (/clear here) ends the turn at the agent's last output; so does the end of the file.
  assert.deepEqual(timeline[4], { kind: "turn_end", at: Date.parse(at(20)), aborted: false });
  assert.deepEqual(timeline.at(-1), { kind: "turn_end", at: Date.parse(at(550)), aborted: false });
  assert.equal(timeline[0]?.kind === "prompt" && timeline[0].text, "make the cart tests pass");
  assert.equal(timeline[3]?.kind === "tool_result" && timeline[3].ok, false);
  assert.equal(sessionOf(s.lines, "other.jsonl"), SESSION);
  assert.equal(sessionOf([{}], "abc.jsonl"), "abc");
});

test("a stuck moment is found where the live check would ask, and the next waits five tool calls", () => {
  const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" }).failing(4).tool("Read", { file_path: "a.ts" });
  const moments = findMoments(readTimeline(s.lines), OPTIONS);
  const stuck = moments.filter((m) => m.decision === "stuck");
  assert.equal(stuck.length, 2);
  const [first, second] = stuck;
  assert.deepEqual(first?.signals, ["repeated_command", "repeated_error"]);
  assert.ok(first?.state.lines.some((l) => l.includes("npm test -- cart")));
  // What happened next starts with the result of the call it was asked about.
  assert.equal(first?.after?.[0], "Bash: npm test -- cart -> ok");
  // The second check comes five calls later and judges only what happened since the first.
  assert.ok((second?.at ?? "") > (first?.at ?? ""));
  assert.equal(first?.question_hash, questionHash(QUESTIONS.stuck));
  assert.deepEqual(first?.labels, ["progressing", "stuck"]);
  for (const m of moments) assert.deepEqual(validateMoment(m).errors, []);
  assert.equal(MOMENT_RULES.stuckCheckEvery, 5);
});

test("long commands and errors are cut so every line fits the moments format", () => {
  const long = "x".repeat(5000);
  const s = new Session()
    .prompt("make the cart tests pass")
    .failing(3)
    .tool("Bash", { command: `npm test -- ${long}` }, { error: `Error: ${long}` });
  const [first] = findMoments(readTimeline(s.lines), OPTIONS);
  assert.ok((first?.after ?? []).every((line) => line.length <= 400));
  assert.deepEqual(validateMoment(first).errors, []);
});

test("Claude Code's own questions are never a stuck moment", () => {
  const s = new Session().prompt("make the cart tests pass").failing(3).tool("AskUserQuestion", { questions: [] });
  assert.equal(findMoments(readTimeline(s.lines), OPTIONS).length, 0);
});

test("a new task in a large conversation is a fresh-start moment after the turn and when its prompt is held", () => {
  const s = new Session()
    .prompt("fix the login bug in the auth module")
    .tool("Edit", { file_path: "src/auth.ts" }, {}, 150_000)
    .answer(150_000)
    .prompt("write release notes for the android store listing");
  const moments = findMoments(readTimeline(s.lines), OPTIONS);
  assert.deepEqual(
    moments.map((m) => [m.trigger, m.signals]),
    [
      ["turn", ["large_context"]],
      ["prompt", ["large_context", "new_prompt_low_overlap"]],
    ],
  );
  const [turn, held] = moments;
  assert.equal(turn?.after?.[0], "User: write release notes for the android store listing");
  assert.ok(!turn?.state.lines.some((l) => l.startsWith("New prompt:")));
  assert.ok(held?.state.lines.some((l) => l.startsWith("New prompt: write release notes")));
  assert.deepEqual(held?.after, ["(the session ends here)"]);
  assert.deepEqual(held?.labels, ["continue", "compact", "clear"]);
  for (const m of moments) assert.deepEqual(validateMoment(m).errors, []);
});

test("a prompt is held only as the plugin holds it: 20,000 tokens or more, a new task, no @ mention", () => {
  const big = () => new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 60_000).answer(60_000);
  const held = (s: Session) => findMoments(readTimeline(s.lines), OPTIONS).filter((m) => m.trigger === "prompt");
  assert.equal(held(big().prompt("write release notes for the android store listing")).length, 1);
  assert.equal(held(big().prompt("write release notes for @docs/android.md store listing")).length, 0);
  assert.equal(held(big().prompt("and the login bug in the auth module tests too")).length, 0);
  const small = new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 15_000).answer(15_000);
  assert.equal(held(small.prompt("write release notes for the android store listing")).length, 0);
});

test("after a turn the check asks again only once the conversation grew by half, and a compaction starts over", () => {
  const s = new Session().prompt("build the whole billing service");
  for (const tokens of [110_000, 130_000, 160_000, 170_000, 250_000]) {
    s.tool("Read", { file_path: "a.ts" }, {}, tokens).answer(tokens).prompt("keep going with the billing service");
  }
  const turns = findMoments(readTimeline(s.lines), { ...OPTIONS, window: 200_000 }).filter((m) => m.trigger === "turn");
  // 110k asks; 130k and 160k are under 165k; 170k asks; 250k is under 255k.
  assert.deepEqual(
    turns.map((m) => m.state.lines.find((l) => l.startsWith("Conversation size"))),
    ["Conversation size: 110000 tokens (55% of the window).", "Conversation size: 170000 tokens (85% of the window)."],
  );
  const compacted = new Session().prompt("build the whole billing service").tool("Read", { file_path: "a.ts" }, {}, 120_000).answer(120_000);
  compacted.command("compact").compact().prompt("keep going with the billing service").tool("Read", { file_path: "a.ts" }, {}, 125_000).answer(125_000);
  // The turn before /compact ends before the compaction, and the next one is checked afresh.
  assert.equal(findMoments(readTimeline(compacted.lines), OPTIONS).filter((m) => m.trigger === "turn").length, 2);
});

test("an interrupted turn is not checked when it ends, but an idle spell after it still is", () => {
  const s = new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 150_000).interrupt();
  assert.equal(findMoments(readTimeline(s.lines), OPTIONS).length, 0);
  s.wait(4000).prompt("and the auth module tests for the login bug");
  assert.deepEqual(
    findMoments(readTimeline(s.lines), OPTIONS).map((m) => m.trigger),
    ["idle"],
  );
});

test("an idle spell is a fresh-start moment once the cache lifetime and half a minute have passed", () => {
  const big = new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 60_000).answer(60_000);
  const ended = big.now;
  big.wait(4000).prompt("and also the login bug in the auth tests");
  const [expired] = findMoments(readTimeline(big.lines), OPTIONS);
  assert.equal(expired?.trigger, "idle");
  assert.deepEqual(expired?.signals, ["cache_expired"]);
  assert.equal(expired?.at, new Date(ended + 3600_000 + 30_000).toISOString());
  assert.equal(expired?.after?.[0], "User: and also the login bug in the auth tests");

  // Back before the idle check would have run: nothing.
  const early = new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 60_000).answer(60_000);
  early.wait(3600).prompt("and also the login bug in the auth tests");
  assert.equal(findMoments(readTimeline(early.lines), OPTIONS).length, 0);

});

test("compactions and commands between turns keep the checks the plugin made before them", () => {
  const answered = () =>
    new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 170_000).answer(170_000);
  const kinds = (s: Session) => readTimeline(s.lines).map((e) => e.kind);
  const triggers = (s: Session) => findMoments(readTimeline(s.lines), { ...OPTIONS, window: 200_000 }).map((m) => m.trigger);

  // An automatic compaction when the next prompt is sent: the turn had ended, and the plugin saw the prompt first.
  const auto = answered().compact().prompt("write release notes for the android store listing");
  assert.deepEqual(kinds(auto).slice(-3), ["turn_end", "prompt", "compact"]);
  assert.deepEqual(triggers(auto), ["turn", "prompt"]);

  // Two hours later: the idle check ran an hour and half a minute after the turn, whatever came next.
  const ended = answered();
  const end = ended.now;
  ended.wait(7200).compact().prompt("write release notes for the android store listing");
  const idle = findMoments(readTimeline(ended.lines), { ...OPTIONS, window: 200_000 });
  assert.deepEqual(
    idle.map((m) => m.trigger),
    ["turn", "idle", "prompt"],
  );
  assert.equal(idle[1]?.at, new Date(end + 3600_000 + 30_000).toISOString());
  const typed = answered();
  typed.wait(7200).command("compact").compact().prompt("write release notes for the android store listing");
  assert.deepEqual(triggers(typed), ["turn", "idle"]);
  const custom = answered();
  custom.wait(7200).command("review").tool("Read", { file_path: "a.ts" }, {}, 171_000).answer(171_000);
  assert.deepEqual(triggers(custom), ["turn", "idle"]);

  // An automatic compaction in the middle of a turn ends nothing.
  const midTurn = new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 170_000);
  midTurn.compact().tool("Edit", { file_path: "src/auth.ts" }, {}, 30_000).answer(30_000);
  assert.deepEqual(kinds(midTurn).filter((k) => k === "turn_end" || k === "compact"), ["compact", "turn_end"]);
  assert.deepEqual(triggers(midTurn), []);

  // A task notification starts a new turn, so the one before it has ended.
  const notified = answered();
  notified.lines.push({
    type: "user",
    sessionId: SESSION,
    timestamp: at(9000),
    origin: { kind: "task-notification" },
    message: { role: "user", content: "<task-notification>done</task-notification>" },
  });
  assert.deepEqual(kinds(notified).slice(-1), ["turn_end"]);
  assert.deepEqual(triggers(notified), ["turn"]);

  // A prompt that is only a pasted image still ends the turn, so the idle check before it is kept.
  const imageOnly = answered();
  imageOnly.wait(7200).lines.push({
    type: "user",
    sessionId: SESSION,
    timestamp: new Date(imageOnly.now + 10_000).toISOString(),
    message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
  });
  imageOnly.wait(20).answer(171_000);
  assert.deepEqual(triggers(imageOnly), ["turn", "idle"]);

  // A notification while a tool call is still running does not end the turn.
  const running = new Session().prompt("fix the login bug in the auth module");
  running.lines.push({
    type: "assistant",
    sessionId: SESSION,
    timestamp: at(100),
    requestId: "req_run",
    message: { role: "assistant", usage: { input_tokens: 170_000 }, content: [{ type: "tool_use", id: "toolu_run", name: "Bash", input: { command: "sleep 60" } }] },
  });
  running.lines.push({
    type: "user",
    sessionId: SESSION,
    timestamp: at(110),
    origin: { kind: "task-notification" },
    message: { role: "user", content: "<task-notification>done</task-notification>" },
  });
  running.lines.push({
    type: "user",
    sessionId: SESSION,
    timestamp: at(170),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_run", content: "ok" }] },
  });
  assert.deepEqual(kinds(running), ["prompt", "context", "tool_use", "tool_result", "turn_end"]);
});

test("as in the plugin, no stuck question where Claude Code shows no dialog, and no hold for a prompt with an image", () => {
  const stuck = (mode: string) =>
    findMoments(readTimeline(new Session().prompt("make the cart tests pass", { permissionMode: mode }).failing(3).tool("Bash", { command: "ls" }).lines), OPTIONS);
  assert.equal(stuck("acceptEdits").length, 1);
  assert.equal(stuck("bypassPermissions").length, 0);
  const s = new Session().prompt("fix the login bug in the auth module").tool("Edit", { file_path: "src/auth.ts" }, {}, 60_000).answer(60_000);
  s.lines.push({
    type: "user",
    sessionId: SESSION,
    timestamp: new Date(s.now + 10_000).toISOString(),
    message: {
      role: "user",
      content: [
        { type: "text", text: "write release notes for the android store listing" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      ],
    },
  });
  assert.deepEqual(findMoments(readTimeline(s.lines), OPTIONS), []);
});

test("a cut never leaves half a character, and half characters in the input are repaired", () => {
  assert.equal(clip(`${"a".repeat(9)}\u{1F600}`, 10), "a".repeat(9));
  assert.equal(clip(`${"a".repeat(8)}\u{1F600}`, 10), `${"a".repeat(8)}\u{1F600}`);
  assert.equal(wellFormed("x\ud83d y \udc00"), "x\ufffd y \ufffd");
  assert.equal(wellFormed("ok \u{1F600}"), "ok \u{1F600}");
  const prompt = `${"word ".repeat(79)}x\u{1F600}\u{1F600}\u{1F600} and more words after the emoji`;
  for (let shift = 0; shift < 4; shift += 1) {
    const s = new Session()
      .prompt(`${"y".repeat(shift)}${prompt}`)
      .tool("Edit", { file_path: "src/auth.ts" }, {}, 150_000)
      .answer(150_000)
      .prompt(`${"z".repeat(shift)} write release notes for the android store listing \u{1F600}`.repeat(30));
    for (const m of findMoments(readTimeline(s.lines), OPTIONS)) {
      assert.doesNotMatch(JSON.stringify(m), /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
      assert.ok(isWellFormed(JSON.stringify(m)));
    }
  }
});

test("a session over 200,000 tokens runs on a 1M window, and the summary matches the plugin's", async () => {
  assert.equal(inferWindow(150_000), 200_000);
  assert.equal(inferWindow(250_000), 1_000_000);
  const s = new Session().prompt("migrate the billing service to the new client");
  s.tool("Read", { file_path: "a.ts" }, {}, 250_000).answer(250_000).prompt("write release notes for the android store listing");
  const dir = await mkdtemp(join(tmpdir(), "ts-moments-"));
  try {
    const path = join(dir, `${SESSION}.jsonl`);
    await writeFile(path, s.lines.map((l) => JSON.stringify(l)).join("\n"));
    // 250k of a 1M window is not large, but the new task is still held.
    const moments = await momentsFromSession(path, { cacheTtlSeconds: 3600 });
    assert.deepEqual(
      moments.map((m) => [m.trigger, m.signals]),
      [["prompt", ["new_prompt_low_overlap"]]],
    );
    const forced = await momentsFromSession(path, { cacheTtlSeconds: 3600, window: 200_000 });
    assert.deepEqual(
      forced.map((m) => m.trigger),
      ["turn", "prompt"],
    );

    // The plugin's tracker keeps the same observations, with the window it learned; the summary is identical.
    const plugin: Observation[] = [];
    const t = (seconds: number) => T0 + seconds * 1000;
    rememberIn(plugin, { kind: "prompt", at: t(10), text: "migrate the billing service to the new client" });
    rememberIn(plugin, { kind: "context", at: t(20), tokens: 250_000, window: 1_000_000 });
    rememberIn(plugin, { kind: "tool", at: t(30), tool: "Read", ok: true });
    rememberIn(plugin, { kind: "context", at: t(40), tokens: 250_000, window: 1_000_000 });
    const prompt = "write release notes for the android store listing";
    const signals = freshStartSignals({ observations: plugin, prompt, now: t(50), cacheTtlSeconds: 3600 });
    const state = buildState({ name: "fresh_start", observations: plugin, signals, now: t(50), newPrompt: prompt });
    assert.equal(moments[0]?.state.hash, state.hash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("moment ids are stable, and a merge keeps labels and refreshes everything else", () => {
  const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" });
  const once = findMoments(readTimeline(s.lines), OPTIONS);
  const again = findMoments(readTimeline(s.lines), OPTIONS);
  assert.deepEqual(
    once.map((m) => m.id),
    again.map((m) => m.id),
  );
  assert.equal(momentId("stuck", "tool", SESSION, 1), momentId("stuck", "tool", SESSION, 1));
  assert.notEqual(momentId("stuck", "tool", SESSION, 1), momentId("stuck", "tool", SESSION, 2));
  assert.notEqual(momentId("fresh_start", "turn", SESSION, 1), momentId("fresh_start", "idle", SESSION, 1));
  const score = { engine: { kind: "rules" as const }, probabilities: { stuck: 0.9 }, at: at(1) };
  const labelled = once.map((m) => ({ ...m, label: "stuck", labelled_at: at(9999), scores: [score] }));
  const same = mergeMoments(labelled, again);
  assert.deepEqual([same.added, same.changed], [0, 0]);
  assert.equal(same.moments[0]?.label, "stuck");
  assert.deepEqual(same.moments[0]?.scores, [score]);

  // A summary that came out different (a new version, another window) keeps the label;
  // the new summary and "what happened next" replace the old, and the old scores go.
  const stale = labelled.map((m) => ({ ...m, state: { lines: ["old"], hash: `sha256:${"1".repeat(64)}` }, after: ["old"] }));
  const refreshed = mergeMoments(stale, again);
  assert.equal(refreshed.changed, 1);
  assert.equal(refreshed.moments[0]?.label, "stuck");
  assert.deepEqual(refreshed.moments[0]?.state, again[0]?.state);
  assert.deepEqual(refreshed.moments[0]?.after, again[0]?.after);
  assert.deepEqual(refreshed.moments[0]?.scores, []);

  // After a question is reworded, the label stays and the old answers go.
  const reworded = mergeMoments(
    labelled.map((m) => ({ ...m, question_hash: `sha256:${"0".repeat(64)}` })),
    again,
  );
  assert.equal(reworded.changed, 1);
  assert.equal(reworded.moments[0]?.question_hash, questionHash(QUESTIONS.stuck));
  assert.equal(reworded.moments[0]?.label, "stuck");
  assert.deepEqual(reworded.moments[0]?.scores, []);
  const renamed = mergeMoments(
    labelled.map((m) => ({ ...m, label: "looping" })),
    again,
  );
  assert.equal(renamed.moments[0]?.label, undefined);
  assert.equal(renamed.moments[0]?.labelled_at, undefined);
});

test("a save keeps labels given in the meantime, and copies from a forked session are dropped unless labelled", () => {
  const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" });
  const [mine] = findMoments(readTimeline(s.lines), OPTIONS) as [Moment];
  const score = { engine: { kind: "openrouter" as const, model: "m" }, probabilities: { stuck: 0.9 }, at: at(5) };
  const [saved] = mergeOntoDisk([{ ...mine, label: "stuck", labelled_at: at(99) }], [{ ...mine, scores: [score] }]);
  assert.equal(saved?.label, "stuck");
  assert.deepEqual(saved?.scores, [score]);
  // An undo on disk (no label) is not reverted by this run's older copy that still has the label.
  const [undone] = mergeOntoDisk([mine], [{ ...mine, label: "stuck", labelled_at: at(99) }]);
  assert.equal(undone?.label, undefined);

  const fork = findMoments(readTimeline(s.lines), { ...OPTIONS, session: "0fork" })[0] as Moment;
  assert.equal(fork.state.hash, mine.state.hash);
  assert.notEqual(fork.id, mine.id);
  assert.deepEqual(
    dropCopies([mine, fork]).moments.map((m) => m.session),
    ["0fork"],
  );
  const one = dropCopies([{ ...mine, label: "stuck", labelled_at: at(99) }, fork]);
  assert.deepEqual([one.moments.map((m) => m.session), one.dropped], [[SESSION], 1]);
  const two = dropCopies([
    { ...mine, label: "stuck", labelled_at: at(99) },
    { ...fork, label: "progressing", labelled_at: at(99) },
  ]);
  assert.equal(two.moments.length, 2);
});

test("the shared example moments pass and every invalid one is rejected at the expected field", () => {
  const lines = readFileSync(new URL("moments.example.jsonl", examples), "utf8").split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.deepEqual(validateMomentText(line).errors, []);
  const cases = JSON.parse(readFileSync(new URL("invalid-moments.json", examples), "utf8")) as {
    why: string;
    path: string;
    errors: string[];
    moment: unknown;
  }[];
  assert.equal(cases.length, 11);
  for (const c of cases) {
    const result = validateMoment(c.moment);
    assert.equal(result.ok, false, `accepted: ${c.why}`);
    assert.ok(result.errors.some((e) => e.startsWith(`${c.path} `)), `${c.why}: expected an error at ${c.path}, got ${JSON.stringify(result.errors)}`);
    // The Python package gives exactly the same messages for these cases.
    assert.deepEqual(result.errors, c.errors, c.why);
  }
});

test("the shared threshold cases give the expected band", () => {
  const cases = JSON.parse(readFileSync(new URL("threshold-cases.json", examples), "utf8")) as {
    why: string;
    probabilities: Record<string, number>;
    thresholds: Record<string, { act: number; unsure: number }>;
    expected: unknown;
  }[];
  assert.equal(cases.length, 15);
  for (const c of cases) assert.deepEqual(applyThresholds(c.probabilities, c.thresholds), c.expected, c.why);
});

test("session files are found under the projects folder, without subagent files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ts-moments-"));
  try {
    await mkdir(join(dir, "proj-a", SESSION, "subagents"), { recursive: true });
    await writeFile(join(dir, "proj-a", `${SESSION}.jsonl`), "");
    await writeFile(join(dir, "proj-a", SESSION, "subagents", "agent-1.jsonl"), "");
    await writeFile(join(dir, "proj-a", "notes.txt"), "");
    const found = await findSessionFiles([dir, join(dir, "nowhere")]);
    assert.deepEqual(found, { files: [join(dir, "proj-a", `${SESSION}.jsonl`)], missing: [join(dir, "nowhere")] });
    assert.deepEqual((await findSessionFiles([dir], 1, Date.now() + 3 * 86_400_000)).files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a moments file round-trips, and a damaged line stops the read with its line number", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ts-moments-"));
  try {
    const path = join(dir, "moments.jsonl");
    assert.deepEqual(await readMomentsFile(path), []);
    const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" });
    const moments = findMoments(readTimeline(s.lines), OPTIONS);
    await writeMomentsFile(path, moments);
    assert.deepEqual(await readMomentsFile(path), moments);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    const good = await readFile(path, "utf8");
    await writeFile(path, `${good}{"v":1}\n`);
    await assert.rejects(readMomentsFile(path), /line 2: <root> is missing the required field/);
    // The same id twice is refused, naming both lines.
    await writeFile(path, `${good}\n${good}`);
    await assert.rejects(readMomentsFile(path), new RegExp(`line 3: the id ${moments[0]?.id} is already used on line 1$`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoring adds each engine's answer; a failure leaves the moment as it was", async () => {
  const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" });
  const moments = findMoments(readTimeline(s.lines), OPTIONS);
  const rules = await scoreMoments(new RulesEngine(), moments, { timeoutMs: 1000 });
  assert.equal(rules.scored, 1);
  assert.equal(moments[0]?.scores[0]?.engine.kind, "rules");

  let calls = 0;
  const model: DecisionEngine = {
    info: { kind: "openrouter", model: "microsoft/microsoft-decision-1-20261009" },
    remote: true,
    decide: async () => {
      calls += 1;
      if (calls > 1) throw new Error("network down");
      return { probabilities: { progressing: 0.03, stuck: 0.97 }, modelVersion: "microsoft/microsoft-decision-1-20261009", costUsd: 0.00001 };
    },
  };
  const first = await scoreMoments(model, moments, { timeoutMs: 1000 });
  assert.deepEqual([first.scored, first.costUsd], [1, 0.00001]);
  assert.deepEqual(moments[0]?.scores[1]?.probabilities, { progressing: 0.03, stuck: 0.97 });
  assert.equal(moments[0]?.scores[1]?.engine.model_version, "microsoft/microsoft-decision-1-20261009");
  const second = await scoreMoments(model, moments, { timeoutMs: 1000 });
  assert.deepEqual([second.scored, second.failed, second.firstError], [0, 1, "network down"]);
  assert.equal(moments[0]?.scores.length, 2);
  for (const m of moments) assert.deepEqual(validateMoment(m).errors, []);

  const slow: DecisionEngine = { ...model, decide: (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")))) };
  const timedOut = await scoreMoments(slow, moments, { timeoutMs: 20 });
  assert.match(timedOut.firstError ?? "", /^timeout/);
});

test("an answer that could not be stored is never allowed to cost a labelled moment", async () => {
  const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" });
  const moments = findMoments(readTimeline(s.lines), OPTIONS).map((m) => ({ ...m, label: "stuck", labelled_at: at(99) }));
  const odd: DecisionEngine = {
    info: { kind: "openrouter", model: "some/model" },
    remote: true,
    decide: async () => ({ probabilities: { stuck: 0.9, progressing: 0.1 }, modelVersion: "some model (v2) with spaces" }),
  };
  const result = await scoreMoments(odd, moments, { timeoutMs: 1000 });
  assert.equal(result.scored, 1);
  // A model version that is not a short token is left out, as the event log does.
  assert.deepEqual(moments[0]?.scores[0]?.engine, { kind: "openrouter", model: "some/model" });
  assert.equal(moments[0]?.label, "stuck");
  assert.deepEqual(validateMoment(moments[0]).errors, []);

  const offLabel: DecisionEngine = { ...odd, decide: async () => ({ probabilities: { looping: 1 } }) };
  const none = await scoreMoments(offLabel, moments, { timeoutMs: 1000 });
  assert.deepEqual([none.scored, none.failed], [0, 1]);
  assert.match(none.firstError ?? "", /^bad_response/);
  const badName: DecisionEngine = { ...odd, info: { kind: "openrouter", model: "a model with spaces" } };
  const refused = await scoreMoments(badName, moments, { timeoutMs: 1000 });
  assert.deepEqual([refused.scored, refused.failed], [0, 1]);
  assert.match(refused.firstError ?? "", /could not be stored/);
  assert.equal(moments[0]?.scores.length, 1);
  assert.equal(moments[0]?.label, "stuck");
});

test("two commands saving at once both land, and a lock left by a crash is taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ts-moments-"));
  try {
    const path = join(dir, "moments.jsonl");
    const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" }).failing(5);
    const [a, b] = findMoments(readTimeline(s.lines), OPTIONS) as [Moment, Moment];
    await writeMomentsFile(path, [{ ...a, label: "stuck", labelled_at: at(99) }]);
    const score = { engine: { kind: "rules" as const }, probabilities: { stuck: 0.8, progressing: 0.2 }, at: at(5) };
    // One run read the file before the label was given; another adds a new moment.
    await Promise.all([updateMomentsFile(path, [{ ...a, scores: [score] }]), updateMomentsFile(path, [b])]);
    const saved = await readMomentsFile(path);
    assert.deepEqual(
      saved.map((m) => [m.id, m.label, m.scores.length]),
      [
        [a.id, "stuck", 1],
        [b.id, undefined, 0],
      ],
    );

    const lock = `${path}.lock`;
    await writeFile(lock, "12345 crashed\n");
    const old = new Date(Date.now() - MOMENTS_LOCK.staleMs - 60_000);
    await utimes(lock, old, old);
    await updateMomentsFile(path, [b]);
    await assert.rejects(stat(lock), { code: "ENOENT" });

    // A lock is removed afterwards only if it is still this command's own.
    await withMomentsLock(path, async () => writeFile(lock, "someone else\n"));
    assert.equal(await readFile(lock, "utf8"), "someone else\n");
    await rm(lock);

    // A copy from a forked session does not replace the copy already saved, which a labeller may be showing.
    const fork = { ...a, id: "0fork-copy", session: "0fork" };
    await updateMomentsFile(path, [fork]);
    assert.ok((await readMomentsFile(path)).some((m) => m.id === a.id));
    assert.ok(!(await readMomentsFile(path)).some((m) => m.id === fork.id));

    // A file that is not UTF-8 is refused rather than read with replacement characters.
    const latin = join(dir, "latin.jsonl");
    await writeFile(latin, Buffer.from([0x7b, 0xe9, 0x7d, 0x0a]));
    await assert.rejects(readMomentsFile(latin), /is not UTF-8 text/);

    // A lock in use is waited for, then reported with how to clear it.
    await writeFile(lock, `${process.pid} now\n`);
    let clock = Date.now();
    const later = () => (clock += 6_000);
    await assert.rejects(
      withMomentsLock(path, async () => "never", later),
      (error: unknown) => error instanceof MomentsFileError && error.message.includes(`delete ${lock}`),
    );
    assert.equal(await readFile(lock, "utf8"), `${process.pid} now\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("twosystems moments finds moments, adds rules scores, and keeps labels on the next run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ts-moments-"));
  const env = { ...process.env };
  try {
    process.env["TWOSYSTEMS_HOME"] = join(dir, "home");
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["TWOSYSTEMS_ENGINE"];
    const projects = join(dir, "projects");
    await mkdir(join(projects, "proj"), { recursive: true });
    const s = new Session().prompt("make the cart tests pass").failing(3).tool("Bash", { command: "npm test -- cart" });
    await writeFile(join(projects, "proj", `${SESSION}.jsonl`), `${s.lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);

    const out = join(dir, "home", "moments.jsonl");
    const write = process.stdout.write.bind(process.stdout);
    const said: string[] = [];
    process.stdout.write = ((chunk: string) => (said.push(String(chunk)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main(["moments", "--from", projects]);
    } finally {
      process.stdout.write = write;
    }
    assert.equal(code, 0);
    assert.match(said.join(""), /1 moment\(s\) in .*: 1 stuck, 0 fresh start; 1 new, 0 labelled/);
    const [found] = await readMomentsFile(out);
    assert.equal(found?.scores[0]?.engine.kind, "rules");

    // A label given later survives the next export, and the rules score is not added twice.
    await writeMomentsFile(out, [{ ...(found as Moment), label: "stuck", labelled_at: at(99_999) }]);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      assert.equal(await main(["moments", "--from", projects, "--score"]), 0);
    } finally {
      process.stdout.write = write;
    }
    const [kept] = await readMomentsFile(out);
    assert.equal(kept?.label, "stuck");
    assert.equal(kept?.scores.length, 1);

    // A damaged moments file is never overwritten.
    await writeFile(out, "{}\n");
    const errors: string[] = [];
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await main(["moments", "--from", projects]), 1);
    } finally {
      process.stderr.write = writeErr;
    }
    assert.match(errors.join(""), /Nothing was changed/);
    assert.equal(await readFile(out, "utf8"), "{}\n");
    assert.equal(await main(["moments", "--days", "0"]), 2);
    assert.equal(await main(["moments", "--window", "5"]), 2);

    // A folder that does not exist is named, not silently skipped.
    await rm(out);
    errors.length = 0;
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      assert.equal(await main(["moments", "--from", join(dir, "nowhere"), "--from", projects]), 0);
    } finally {
      process.stderr.write = writeErr;
      process.stdout.write = write;
    }
    assert.match(errors.join(""), /Not found, skipped: .*nowhere/);
  } finally {
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  }
});
