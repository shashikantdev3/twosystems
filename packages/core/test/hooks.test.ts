// Tests for reading hook payloads and writing hook replies. Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askBeforeTool, eventKind, isEditTool, lastTranscriptUsage, parseHookPayload, showNote } from "../src/hooks.js";

const NOW = Date.parse("2026-10-19T10:00:00Z");

test("event names in every known spelling map to one kind", () => {
  assert.equal(eventKind("UserPromptSubmit"), "prompt");
  assert.equal(eventKind("userPromptSubmitted"), "prompt");
  assert.equal(eventKind("PreToolUse"), "pre_tool");
  assert.equal(eventKind("preToolUse"), "pre_tool");
  assert.equal(eventKind("PostToolUseFailure"), "post_tool_failure");
  assert.equal(eventKind("agentStop"), "stop");
  assert.equal(eventKind("SubagentStop"), "other");
});

test("Claude Code style payloads are read field by field", () => {
  const input = parseHookPayload(
    {
      session_id: "abc",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "npm test" },
      error: "Exit code 1",
      transcript_path: "/t.jsonl",
      timestamp: "2026-10-19T09:00:00Z",
    },
    undefined,
    NOW,
  );
  assert.deepEqual(input, {
    style: "snake",
    promptNotesShown: true,
    event: "post_tool_failure",
    rawEvent: "PostToolUseFailure",
    session: "abc",
    at: Date.parse("2026-10-19T09:00:00Z"),
    toolName: "Bash",
    toolUseId: "toolu_1",
    command: "npm test",
    ok: false,
    error: "Exit code 1",
    transcriptPath: "/t.jsonl",
  });
});

test("Copilot CLI style payloads take the event from the flag and parse toolArgs text", () => {
  const input = parseHookPayload(
    {
      sessionId: "s1",
      timestamp: 1792404000000,
      toolName: "bash",
      toolArgs: '{"command":"pytest -q"}',
      toolResult: { resultType: "failure", textResultForLlm: "1 failed" },
    },
    "postToolUse",
    NOW,
  );
  assert.equal(input?.style, "camel");
  assert.equal(input?.promptNotesShown, false);
  assert.equal(input?.event, "post_tool");
  assert.equal(input?.at, 1792404000000);
  assert.equal(input?.command, "pytest -q");
  assert.equal(input?.ok, false);
  assert.equal(input?.error, "1 failed");
});

test("tool outcomes are read from the shapes agents use", () => {
  const post = (response: unknown, tool = "runInTerminal", toolInput: unknown = { command: "x" }) =>
    parseHookPayload({ session_id: "s", hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput, tool_response: response }, undefined, NOW);
  assert.equal(post({ exitCode: 2, stderr: "boom" })?.error, "boom");
  assert.equal(post({ exit_code: 0, stdout: "fine" })?.ok, true);
  assert.equal(post({ is_error: true })?.ok, false);
  assert.equal(post("plain text result")?.ok, true);
  assert.deepEqual(post({ success: true }, "Edit", { file_path: "a.ts" })?.files, ["a.ts"]);
  assert.deepEqual(post("ok", "editFiles", { files: ["a.ts", "b.ts"] })?.files, ["a.ts", "b.ts"]);
  assert.deepEqual(post("ok", "create_file", {})?.files, ["(unnamed file)"]);
  assert.equal(post({ success: false }, "Edit", { file_path: "a.ts" })?.files, undefined);
});

test("payloads without a session or an event are ignored", () => {
  assert.equal(parseHookPayload({ hook_event_name: "Stop" }, undefined, NOW), null);
  assert.equal(parseHookPayload({ sessionId: "s" }, undefined, NOW), null);
  assert.equal(parseHookPayload("text", undefined, NOW), null);
  assert.equal(parseHookPayload(null, "stop", NOW), null);
});

test("cache hints and context sizes from Claude Code are kept", () => {
  const resume = parseHookPayload(
    { session_id: "s", hook_event_name: "SessionStart", source: "resume", context_tokens: 91234.6, prompt_cache_likely_expired: true },
    undefined,
    NOW,
  );
  assert.equal(resume?.contextTokens, 91235);
  assert.equal(resume?.cacheExpired, true);
  const warm = parseHookPayload({ session_id: "s", hook_event_name: "PreModelSwitch", prompt_cache_warm: true }, undefined, NOW);
  assert.equal(warm?.cacheExpired, false);
});

test("replies use the shape each agent expects", () => {
  const snake = parseHookPayload({ session_id: "s", hook_event_name: "PreToolUse" }, undefined, NOW);
  const camel = parseHookPayload({ sessionId: "s" }, "preToolUse", NOW);
  assert.ok(snake && camel);
  assert.deepEqual(askBeforeTool(snake, "why"), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "why" },
  });
  assert.deepEqual(askBeforeTool(camel, "why"), { permissionDecision: "ask", permissionDecisionReason: "why" });
  assert.deepEqual(showNote(snake, "note"), { systemMessage: "note" });
  assert.deepEqual(showNote(camel, "note"), {});
});

test("the last usage in a Claude Code transcript gives the conversation size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twosystems-transcript-"));
  const path = join(dir, "t.jsonl");
  const line = (usage: Record<string, number>, id: string) =>
    JSON.stringify({ type: "assistant", requestId: id, message: { id: `m-${id}`, model: "claude-sonnet-5-5", usage } });
  await writeFile(
    path,
    [
      line({ input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }, "r1"),
      '{"type":"user","message":{"content":"hi"}}',
      line({ input_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, output_tokens: 7 }, "r2"),
      "{broken json with \"usage\"",
      "",
    ].join("\n"),
  );
  assert.deepEqual(await lastTranscriptUsage(path), {
    contextTokens: 5320,
    inputTokens: 20,
    outputTokens: 7,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
    model: "claude-sonnet-5-5",
    requestId: "r2",
  });
  assert.equal(await lastTranscriptUsage(join(dir, "missing.jsonl")), null);
});

test("the ready-made hook files register only events twosystems understands", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const [file, agent] of [["claude-code", "claude-code"], ["copilot", "copilot"], ["codex", "codex"]] as const) {
    const config = JSON.parse(await readFile(new URL(`../../hooks/${file}.json`, import.meta.url), "utf8")) as { hooks: Record<string, unknown[]> };
    const text = JSON.stringify(config);
    assert.ok(text.includes(`twosystems hook --agent ${agent}`), file);
    for (const event of Object.keys(config.hooks)) assert.notEqual(eventKind(event), "other", `${file}: ${event}`);
    if (file === "copilot") for (const event of Object.keys(config.hooks)) assert.ok(text.includes(`--event ${event}`), event);
  }
});

test("only tools that change files count as file changes", () => {
  for (const name of ["Edit", "MultiEdit", "Write", "NotebookEdit", "editFiles", "create_file", "replace_string_in_file", "apply_patch"]) {
    assert.ok(isEditTool(name), name);
  }
  for (const name of ["TodoWrite", "NotebookRead", "Read", "mcp__github__create_issue", "get_file_edits", "Bash", "WebFetch"]) {
    assert.ok(!isEditTool(name), name);
  }
});

test("a numeric timestamp marks the Copilot CLI, where prompt notes are not shown", () => {
  const cli = parseHookPayload({ session_id: "s", hook_event_name: "UserPromptSubmit", timestamp: 1792404000000 }, undefined, NOW);
  const vscode = parseHookPayload({ session_id: "s", hook_event_name: "UserPromptSubmit", timestamp: "2026-10-19T10:00:00Z" }, undefined, NOW);
  const claude = parseHookPayload({ session_id: "s", hook_event_name: "UserPromptSubmit", cwd: "/w" }, undefined, NOW);
  assert.equal(cli?.promptNotesShown, false);
  assert.equal(vscode?.promptNotesShown, true);
  assert.equal(claude?.promptNotesShown, true);
  assert.equal(claude?.cwd, "/w");
});

test("a transcript path that is not a plain file is ignored without blocking", async (t) => {
  if (process.platform === "win32") return t.skip("named pipes work differently on Windows");
  const { execFileSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "twosystems-fifo-"));
  const fifo = join(dir, "pipe");
  execFileSync("mkfifo", [fifo]);
  assert.equal(await lastTranscriptUsage(fifo), null);
  assert.equal(await lastTranscriptUsage(dir), null);
});
