// Tests for the twosystems command, run as a real process. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEventsJsonl } from "../src/contracts.js";

const BIN = fileURLToPath(new URL("../../bin/twosystems.js", import.meta.url));

async function run(args: string[], input = "", extraEnv: Record<string, string> = {}) {
  const home = extraEnv["TWOSYSTEMS_HOME"] ?? (await mkdtemp(join(tmpdir(), "twosystems-cli-")));
  // Keep the system variables a process needs (PATH, SystemRoot on Windows), drop any twosystems settings.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("TWOSYSTEMS_") && entry[0] !== "OPENROUTER_API_KEY" && entry[0] !== "OLLAMA_HOST",
    ),
  );
  const env: Record<string, string> = { ...inherited, TWOSYSTEMS_HOME: home, ...extraEnv };
  const result = spawnSync(process.execPath, [BIN, ...args], { input, env, encoding: "utf8", timeout: 20_000 });
  return { code: result.status, out: result.stdout, err: result.stderr, home };
}

test("version and help", async () => {
  const version = await run(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.out, /^\d+\.\d+\.\d+/);
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /Created by Shashikant/);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["nonsense"])).code, 2);
});

test("hook always answers with JSON and exit code 0, even on bad input", async () => {
  for (const input of ["", "not json", "[1,2]", '{"session_id":"s"}']) {
    const r = await run(["hook", "--agent", "claude-code"], input);
    assert.equal(r.code, 0, input);
    assert.deepEqual(JSON.parse(r.out), {}, input);
  }
});

test("hook records a decision when the agent is stuck, and asks before the next step", async () => {
  const home = await mkdtemp(join(tmpdir(), "twosystems-cli-"));
  const send = (payload: Record<string, unknown>) =>
    run(["hook", "--agent", "claude-code"], JSON.stringify({ session_id: "cli-s1", ...payload }), { TWOSYSTEMS_HOME: home, TWOSYSTEMS_HOLDOUT: "0" });
  await send({ hook_event_name: "UserPromptSubmit", prompt: "make the test pass" });
  for (let i = 0; i < 3; i += 1) {
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `t${i}`, tool_input: { command: "npm test" } });
    await send({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: `t${i}`, tool_input: { command: "npm test" }, error: "AssertionError: 500" });
  }
  const ask = await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t3", tool_input: { command: "npm test" } });
  const reply = JSON.parse(ask.out) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(reply.hookSpecificOutput?.permissionDecision, "ask");
  assert.match(reply.hookSpecificOutput?.permissionDecisionReason ?? "", /^twosystems: the agent may be stuck/);
  const log = await readFile(join(home, "events.jsonl"), "utf8");
  assert.deepEqual(validateEventsJsonl(log).errors, []);
  assert.match(log, /"band":"act"/);

  const receipt = await run(["receipt"], "", { TWOSYSTEMS_HOME: home });
  assert.equal(receipt.code, 0);
  assert.match(receipt.out, /Checks run: +1 \(act 1/);
  assert.match(receipt.out, /Verified saving: +not enough data yet/);
  const json = await run(["receipt", "--json"], "", { TWOSYSTEMS_HOME: home });
  assert.equal((JSON.parse(json.out) as { decisions: { total: number } }).decisions.total, 1);
});

test("doctor reports the setup and never prints the key", async () => {
  const key = ["sk-", "or-v1-", "f".repeat(64)].join("");
  const r = await run(["doctor"], "", { OPENROUTER_API_KEY: key });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /engine: openrouter \(microsoft\/microsoft-decision-1-20261009\), sends a short redacted summary/);
  assert.match(r.out, /OpenRouter key: set/);
  assert.ok(!r.out.includes(key) && !r.err.includes(key));
  const rules = await run(["doctor"]);
  assert.match(rules.out, /engine: rules, stays on this machine/);
  const broken = await run(["doctor"], "", { TWOSYSTEMS_ENGINE: "ollama" });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /FIX +Ollama model: missing/);
});

test("doctor --live reports a failed call without crashing", async () => {
  const r = await run(["doctor", "--live"], "", { TWOSYSTEMS_ENGINE: "ollama", TWOSYSTEMS_MODEL: "nimble", OLLAMA_HOST: "http://127.0.0.1:9", TWOSYSTEMS_TIMEOUT_MS: "500" });
  assert.equal(r.code, 1);
  assert.match(r.out, /FIX +live stuck check failed \((network|timeout)/);
  assert.match(r.out, /FIX +live fresh_start check failed \((network|timeout)/);
});

test("hook processes running at the same time do not lose each other's notes", async () => {
  const home = await mkdtemp(join(tmpdir(), "twosystems-cli-"));
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("TWOSYSTEMS_")));
  const one = (i: number) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [BIN, "hook", "--agent", "claude-code"], { env: { ...inherited, TWOSYSTEMS_HOME: home } });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("close", () => resolve(out));
      child.stdin.end(
        JSON.stringify({ session_id: "par", hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: `t${i}`, tool_input: { file_path: `f${i}.ts` }, tool_response: { success: true } }),
      );
    });
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => one(i)));
  assert.ok(outs.every((o) => o.trim() === "{}"));
  const { loadNotes } = await import("../src/sessions.js");
  const notes = await loadNotes(join(home, "sessions"), "claude-code", "par");
  assert.equal(notes.toolCalls, 10);
});
