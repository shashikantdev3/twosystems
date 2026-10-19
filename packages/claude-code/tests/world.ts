// A small world for the plugin's tests: files in memory, a clock that moves
// only when a test moves it, and the session answers Claude Code would give.
// Part of twosystems, created by Shashikant.
import type { On } from "claude-code";
import { type MockClock, mock } from "claude-code/testing";

export const HOME = "/home/dev";
export const LOG_DIR = `${HOME}/.twosystems/events.d`;
export const START = Date.parse("2026-10-19T10:00:00Z");

export interface World {
  files: Map<string, string>;
  clock: MockClock;
  statuses: string[];
  toasts: string[];
  submitted: string[];
  filled: string[];
  commands: string[];
  compacts: number;
  /** What the next tool call answers. */
  toolAnswer: { isError: boolean; text: string };
  /** What the next model request reports as its context: uncached input and cache reads, in tokens. */
  usage: { input: number; cacheRead: number };
  /** The permission decision Claude Code itself would make for a tool. */
  permission: (tool: string) => { decision: "allow" | "ask" | "deny"; reason?: string };
  /** Every permission question that reached the bottom, with its tool_use_id. */
  checks: Array<{ tool: string; id: string | undefined }>;
  /** Where the session draws; empty for a headless run. */
  surfaces: string[];
  /** Whether a pane the plugin opens is placed. */
  panePlaced: boolean;
  opened: string[];
  closed: string[];
  /** The tool_use_id of every tool call that ran. */
  calls: string[];
  /** How each submitted prompt was framed: the plugin's own, or as the user's words. */
  origins: Array<Record<string, unknown>>;
  /** Run when a command runs, as Claude Code would (a /clear ends the conversation). */
  onCommand: (name: string) => Promise<void>;
  /** What a compaction returns: a summary, or a skip. */
  compactAnswer: "done" | "skip";
  /** What a hook beneath the plugin answers to Claude Code's permission request; empty lets the dialog show. */
  permissionAnswer: Record<string, unknown>;
  /** What the user has typed in the prompt box. */
  draft: string;
  /** Whether the prompt box takes a fill; false while a dialog holds the keys. */
  fillWorks: boolean;
  /** Every event record written so far, from every session file. */
  events: () => Array<Record<string, unknown>>;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

export function world(
  on: On,
  options: { session?: string; window?: number; settings?: Record<string, unknown>; env?: Record<string, string> } = {},
): World {
  const files = new Map<string, string>();
  const w: World = {
    files,
    clock: mock.clock(on, { now: START }),
    statuses: [],
    toasts: [],
    submitted: [],
    filled: [],
    commands: [],
    compacts: 0,
    toolAnswer: { isError: false, text: "ok" },
    permission: () => ({ decision: "allow" }),
    checks: [],
    surfaces: ["terminal"],
    panePlaced: true,
    opened: [],
    closed: [],
    calls: [],
    origins: [],
    onCommand: async () => undefined,
    compactAnswer: "done",
    permissionAnswer: {},
    draft: "",
    fillWorks: true,
    usage: { input: 1000, cacheRead: 0 },
    events: () =>
      [...files.entries()]
        .filter(([path]) => path.startsWith(`${LOG_DIR}/`))
        .flatMap(([, text]) => text.split("\n").filter((line) => line !== ""))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
  mock.env(on, { HOME, ...options.env });
  on("session.id", () => ({ value: options.session ?? "7f9c2a1e-0d3b-4c55-9a77-1b2c3d4e5f60" }));
  on("session.version", () => ({ value: { version: "2.1.303", base: "2.1.303", builtAt: "2026-10-01T00:00:00Z" } }));
  on("session.usage", () => ({ value: { startedAt: START, context: { window: options.window ?? 200_000 }, rateLimits: [] } }));
  on("settings.read", () => ({ value: options.settings ?? {} }));
  on("fs.exists", ($, e) => ({ value: files.has(e.path) }));
  on("fs.read", ($, e) => {
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  on("fs.write", ($, e) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on("fs.list", ($, e) => ({
    value: [...files.keys()]
      .filter((path) => dirOf(path) === e.path)
      .map((path) => ({ name: path.slice(e.path.length + 1), kind: "file" as const, size: (files.get(path) ?? "").length, mtimeMs: 0, isLink: false })),
  }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("ui.status", ($, e) => {
    if (e.text !== undefined) w.statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.toast", ($, e) => {
    w.toasts.push(e.text);
    return { value: undefined };
  });
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", ($, e) => ({ text: e.answer }));
  on("turn.step", async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "done",
      toolUses: [],
      stopReason: "end_turn" as const,
      usage: {
        model: "claude-opus-5-5",
        input_tokens: w.usage.input,
        output_tokens: 200,
        cache_read_input_tokens: w.usage.cacheRead,
        cache_creation_input_tokens: 0,
      },
    };
  });
  on("tool.check", ($, e) => {
    w.checks.push({ tool: e.tool, id: e.tool_use_id });
    return w.permission(e.tool);
  });
  on("session.surfaces", () => ({ value: w.surfaces as never }));
  on("ui.open", ($, e) => {
    w.opened.push(e.id);
    return { value: w.panePlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: "too narrow" } } as never;
  });
  on("ui.close", ($, e) => {
    w.closed.push(e.id);
    return { value: undefined };
  });
  on("classic.UserPromptSubmit", () => ({}));
  on("classic.PostToolUse", () => ({}));
  on("classic.PostToolUseFailure", () => ({}));
  on("classic.PermissionRequest", () => w.permissionAnswer as never);
  on("tool.call", ($, e) => {
    w.calls.push(e.tool_use_id);
    return w.toolAnswer.isError ? { isError: true as const, result: w.toolAnswer.text, text: w.toolAnswer.text } : { result: w.toolAnswer.text, text: w.toolAnswer.text };
  });
  on("prompt.submit", ($, e) => {
    w.submitted.push(e.text);
    w.origins.push({ ...e.origin });
    return { text: e.text };
  });
  on("prompt.read", () => ({ value: { text: w.draft, cursor: w.draft.length } }));
  on("prompt.fill", ($, e) => {
    if (!w.fillWorks) return { isFilled: false, refusal: "dialog" as const, text: w.draft, cursor: w.draft.length };
    w.filled.push(e.text);
    w.draft = e.mode === "replace" ? e.text : `${w.draft}${e.text}`;
    return { isFilled: true, text: w.draft, cursor: w.draft.length };
  });
  on("command.run", async ($, e) => {
    w.commands.push(e.command);
    await w.onCommand(e.command);
    return { text: "" };
  });
  on("session.compact", () => {
    if (w.compactAnswer === "skip") return { skip: "a hook vetoed it" } as never;
    w.compacts += 1;
    return {
      messages: [{ role: "user" as const, text: "Summary of the earlier conversation.", toolUses: [] }],
      usage: { input_tokens: 150_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as never;
  });
  return w;
}

/** Start an interactive session in the terminal, in the default permission mode, as Claude Code reports it. */
export async function start($: {
  session: { start: (e: { cwd: string; surface: "terminal"; isInteractive: boolean }) => Promise<unknown> };
  classic: { UserPromptSubmit: (e: { prompt: string; permission_mode: string }) => Promise<unknown> };
}): Promise<void> {
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true });
  await $.classic.UserPromptSubmit({ prompt: "start", permission_mode: "default" });
}

type TurnHost = {
  turn: {
    start: (e: { text: string; turnId: string }) => Promise<unknown>;
    step: (e: { turnId: string; index: number; model: string; messageCount: number }) => AsyncGenerator<unknown, unknown> & { result: Promise<unknown> };
    complete: (e: { answer: string; durationMs: number; isAborted: boolean; turnId: string; reason: "answer" }) => Promise<{ text: string }>;
  };
};

let turns = 0;

/** One main-loop turn: the prompt, one model request with the world's usage, and the answer. */
export async function turn($: TurnHost, w: World, prompt: string): Promise<{ text: string }> {
  turns += 1;
  const turnId = `turn-${turns}`;
  await $.turn.start({ text: prompt, turnId });
  const stream = $.turn.step({ turnId, index: 0, model: "claude-opus-5-5", messageCount: 2 });
  for await (const _ of stream) {
    // Drain the stream.
  }
  await stream.result;
  await w.clock.advance(5_000);
  const done = await $.turn.complete({ answer: "done", durationMs: 5_000, isAborted: false, turnId, reason: "answer" });
  await w.clock.settle();
  return done;
}

/** The props Claude Code gives the band above the prompt. */
export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
};

/** User actions recorded so far, in order. */
export function actions(w: World): string[] {
  return w
    .events()
    .filter((e) => e["type"] === "user_action")
    .map((e) => (e["user_action"] as Record<string, string>)["action"] ?? "");
}

/** Decision records written so far. */
export function decisions(w: World): Array<Record<string, unknown>> {
  return w
    .events()
    .filter((e) => e["type"] === "decision")
    .map((e) => e["decision"] as Record<string, unknown>);
}
