// Agent hooks: read the JSON an agent passes to a hook command, and write the
// JSON it expects back. Two payload styles exist in October 2026:
// - snake_case with hook_event_name (Claude Code, VS Code agent hooks, Codex);
// - camelCase (GitHub Copilot CLI and cloud agent), where the event name comes
//   from the --event flag in the hook configuration.
// Part of twosystems, created by Shashikant.
import { open, stat } from "node:fs/promises";

export type HookEvent =
  | "session_start"
  | "prompt"
  | "pre_tool"
  | "post_tool"
  | "post_tool_failure"
  | "permission_denied"
  | "pre_compact"
  | "stop"
  | "other";

export type HookStyle = "snake" | "camel";

export interface HookInput {
  style: HookStyle;
  /**
   * False when the agent drops replies to prompt hooks, so a note would never be
   * seen. The Copilot CLI does this; its payloads carry the time as a number,
   * while VS Code sends text and Claude Code sends none.
   */
  promptNotesShown: boolean;
  event: HookEvent;
  /** The event name exactly as the agent wrote it, needed in some replies. */
  rawEvent: string;
  session: string;
  at: number;
  /** The project folder, used to link a /clear (which starts a new session) to the suggestion before it. */
  cwd?: string;
  prompt?: string;
  toolName?: string;
  toolUseId?: string;
  command?: string;
  /** Files a tool call changed, when the input names them. */
  files?: string[];
  /** For finished tool calls: whether it worked, and the start of the error. */
  ok?: boolean;
  error?: string;
  /** SessionStart source: startup, resume, clear, compact or new. */
  source?: string;
  /** PreCompact trigger: manual or auto. */
  trigger?: string;
  contextTokens?: number;
  cacheExpired?: boolean;
  transcriptPath?: string;
}

const EVENTS: Record<string, HookEvent> = {
  sessionstart: "session_start",
  userpromptsubmit: "prompt",
  userpromptsubmitted: "prompt",
  pretooluse: "pre_tool",
  posttooluse: "post_tool",
  posttoolusefailure: "post_tool_failure",
  permissiondenied: "permission_denied",
  precompact: "pre_compact",
  stop: "stop",
  agentstop: "stop",
};

/** Map an event name in any of the known spellings to our event kind. */
export function eventKind(name: string): HookEvent {
  return EVENTS[name.replace(/[^A-Za-z]/g, "").toLowerCase()] ?? "other";
}

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function obj(value: unknown): Json | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const EDIT_WORD = /edit|write|patch|create|replace|insert|delete|rename|move/i;
const NOT_EDIT = /todo|read|search|list|get|fetch|view/i;

/** True for tools that change files: Edit, Write, editFiles, apply_patch and the like. MCP tools are not counted. */
export function isEditTool(name: string): boolean {
  if (/^mcp/i.test(name)) return false;
  return EDIT_WORD.test(name) && !NOT_EDIT.test(name);
}
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file", "filename"];

function filesFrom(toolName: string | undefined, input: Json | undefined): string[] | undefined {
  if (toolName === undefined || !isEditTool(toolName)) return undefined;
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input?.[key];
    if (typeof value === "string") found.push(value);
  }
  const many = input?.["files"] ?? input?.["paths"];
  if (Array.isArray(many)) for (const f of many) if (typeof f === "string") found.push(f);
  return found.length > 0 ? found : ["(unnamed file)"];
}

function commandFrom(input: Json | undefined): string | undefined {
  return str(input?.["command"]) ?? str(input?.["cmd"]) ?? str(input?.["commandLine"]) ?? str(input?.["script"]);
}

// Work out whether a finished tool call failed, from the shapes agents use.
function outcome(response: unknown): { ok: boolean; error?: string } {
  const r = obj(response);
  if (r === undefined) return { ok: true };
  const type = str(r["resultType"]) ?? str(r["result_type"]);
  const text = str(r["textResultForLlm"]) ?? str(r["text_result_for_llm"]);
  if (type !== undefined) return type === "success" ? { ok: true } : { ok: false, ...(text ? { error: text } : {}) };
  const code = r["exit_code"] ?? r["exitCode"] ?? r["returnCode"];
  const failed =
    r["is_error"] === true ||
    r["isError"] === true ||
    r["success"] === false ||
    (typeof code === "number" && code !== 0) ||
    r["interrupted"] === true;
  if (!failed) return { ok: true };
  const error = str(r["error"]) ?? str(r["stderr"]) ?? str(r["output"]) ?? str(r["stdout"]);
  return error ? { ok: false, error } : { ok: false };
}

function timeOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Read a hook payload. Returns null when it is not something we understand.
 * eventFlag is the --event value from the hook configuration.
 */
export function parseHookPayload(payload: unknown, eventFlag: string | undefined, now: number): HookInput | null {
  const p = obj(payload);
  if (p === undefined) return null;
  const style: HookStyle = "sessionId" in p || "toolName" in p ? "camel" : "snake";
  const rawEvent = str(p["hook_event_name"]) ?? str(p["hookEventName"]) ?? eventFlag;
  const session = str(p["session_id"]) ?? str(p["sessionId"]);
  if (rawEvent === undefined || session === undefined) return null;
  const event = eventKind(rawEvent);
  const promptNotesShown = style === "snake" && typeof p["timestamp"] !== "number";
  const input: HookInput = { style, promptNotesShown, event, rawEvent, session, at: timeOf(p["timestamp"], now) };
  const cwd = str(p["cwd"]);
  if (cwd !== undefined) input.cwd = cwd;

  const prompt = str(p["prompt"]);
  if (prompt !== undefined) input.prompt = prompt;
  const toolName = str(p["tool_name"]) ?? str(p["toolName"]);
  if (toolName !== undefined) input.toolName = toolName;
  const toolUseId = str(p["tool_use_id"]) ?? str(p["toolUseId"]);
  if (toolUseId !== undefined) input.toolUseId = toolUseId;
  const toolInput = obj(p["tool_input"]) ?? obj(p["toolArgs"]) ?? obj(p["tool_args"]);
  const command = commandFrom(toolInput);
  if (command !== undefined) input.command = command;

  if (event === "post_tool" || event === "post_tool_failure") {
    const files = filesFrom(toolName, toolInput);
    const result =
      event === "post_tool_failure"
        ? { ok: false, ...(str(p["error"]) ? { error: str(p["error"]) as string } : {}) }
        : outcome(p["tool_response"] ?? p["toolResult"] ?? p["tool_result"]);
    input.ok = result.ok;
    if (result.error !== undefined) input.error = result.error;
    if (files !== undefined && result.ok) input.files = files;
  }

  const source = str(p["source"]);
  if (source !== undefined) input.source = source;
  const trigger = str(p["trigger"]);
  if (trigger !== undefined) input.trigger = trigger;
  const tokens = p["context_tokens"];
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) input.contextTokens = Math.round(tokens);
  if (typeof p["prompt_cache_likely_expired"] === "boolean") input.cacheExpired = p["prompt_cache_likely_expired"];
  else if (typeof p["prompt_cache_warm"] === "boolean") input.cacheExpired = !p["prompt_cache_warm"];
  const transcript = str(p["transcript_path"]) ?? str(p["transcriptPath"]);
  if (transcript !== undefined) input.transcriptPath = transcript;
  return input;
}

/** The JSON a hook prints. Empty means "carry on, nothing to say". */
export type HookOutput = Record<string, unknown>;

/**
 * Reply that asks the user before the next tool call. Used by the stuck check.
 * The agent shows the reason and lets the user allow or stop the call.
 */
export function askBeforeTool(input: HookInput, reason: string): HookOutput {
  if (input.style === "camel") return { permissionDecision: "ask", permissionDecisionReason: reason };
  return {
    hookSpecificOutput: { hookEventName: input.rawEvent, permissionDecision: "ask", permissionDecisionReason: reason },
  };
}

/**
 * Reply that shows a note to the user without blocking anything. Used by the
 * fresh-start check. The Copilot CLI ignores replies to prompt hooks, so there
 * the note is not shown.
 */
export function showNote(input: HookInput, message: string): HookOutput {
  return input.style === "camel" ? {} : { systemMessage: message };
}

export interface TranscriptUsage {
  /** Tokens the model read on the last request: the size of the conversation. */
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model?: string;
  requestId?: string;
  /** When the request was made, from the transcript entry, if it says. */
  at?: number;
}

/**
 * Best effort: the usage of the last model request in a Claude Code transcript.
 * Reads only the end of the file. The transcript format is not a stable
 * interface, so any surprise returns null instead of failing.
 */
export async function lastTranscriptUsage(path: string, tailBytes = 262_144): Promise<TranscriptUsage | null> {
  let handle;
  try {
    // Only plain files: opening a pipe or a device could block the hook.
    if (!(await stat(path)).isFile()) return null;
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined || !line.includes('"usage"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = obj(obj(entry)?.["message"]);
      const usage = obj(message?.["usage"]);
      if (usage === undefined) continue;
      const n = (key: string) => {
        const v = usage[key];
        return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
      };
      const inputTokens = n("input_tokens");
      const cacheReadTokens = n("cache_read_input_tokens");
      const cacheWriteTokens = n("cache_creation_input_tokens");
      const result: TranscriptUsage = {
        contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
        inputTokens,
        outputTokens: n("output_tokens"),
        cacheReadTokens,
        cacheWriteTokens,
      };
      const model = str(message?.["model"]);
      if (model !== undefined) result.model = model;
      const id = str(obj(entry)?.["requestId"]) ?? str(message?.["id"]);
      if (id !== undefined) result.requestId = id;
      const when = Date.parse(str(obj(entry)?.["timestamp"]) ?? "");
      if (Number.isFinite(when)) result.at = when;
      return result;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
