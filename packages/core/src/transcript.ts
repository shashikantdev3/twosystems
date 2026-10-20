// Reading a saved Claude Code session (~/.claude/projects/<project>/<session>.jsonl)
// as a timeline: typed prompts, tool calls and their results, the size of each
// model request, the end of each turn, and compactions. Pure: it takes parsed
// lines one at a time, so a large file never has to be held whole, and it runs
// and is tested anywhere. The transcript format is Claude Code's own and not a
// stable interface, so anything unexpected is skipped rather than fatal.
// Part of twosystems, created by Shashikant.

/** One thing that happened in the main conversation, in the order the plugin would have seen it. Times are milliseconds since 1970. */
export type TimelineEvent =
  /** A prompt the person typed. `images` when it carried pasted images (the plugin never holds those). */
  | { kind: "prompt"; at: number; text: string; images: boolean }
  /** A tool call; `mode` is the permission mode Claude Code last recorded, when it recorded one. */
  | { kind: "tool_use"; at: number; id: string; tool: string; input: Record<string, unknown>; mode?: string }
  | { kind: "tool_result"; at: number; id: string; ok: boolean; text: string }
  | { kind: "context"; at: number; tokens: number }
  /**
   * The agent stopped: the time of its last output, placed before whatever
   * came next (a prompt, a command, a notification, a compaction between
   * turns, or the end of the file). `aborted` when the person interrupted it.
   */
  | { kind: "turn_end"; at: number; aborted: boolean }
  | { kind: "compact"; at: number };

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** Text Claude Code adds around a typed prompt, which is not the person's own words. */
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const INTERRUPTED = /^\[Request interrupted/;
/** A slash command the person typed. */
const COMMAND = /^<command-(name|message)>/;
/** Lines that are commands, command output or notices rather than a typed prompt. */
const NOT_A_PROMPT = /^(<command-name>|<command-message>|<command-args>|<local-command-|<bash-input>|<bash-stdout>|<bash-stderr>|<task-notification>|<user-memory-input>|\[Request interrupted)/;

/** A user entry Claude Code added itself (hook feedback, a compaction summary), which neither starts nor ends a turn. */
function addedByClaudeCode(entry: Json): boolean {
  return entry["isMeta"] === true || entry["isCompactSummary"] === true;
}

/** The person's own words in a user entry, or undefined when it is not a typed prompt. */
function typedPrompt(entry: Json, text: string): string | undefined {
  const origin = obj(entry["origin"]);
  if (origin !== undefined && origin["kind"] !== "human") return undefined;
  if (text === "" || NOT_A_PROMPT.test(text)) return undefined;
  return text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(obj)
      .filter((b) => b?.["type"] === "text")
      .map((b) => str(b?.["text"]) ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Builds one session's main-conversation timeline from its parsed lines, fed
 * in file order. Subagent lines (isSidechain) are left out; a model request
 * split over several lines is counted once.
 */
export class TimelineBuilder {
  readonly events: TimelineEvent[] = [];
  /** The first session id seen, if any. */
  session: string | undefined;
  /** The largest request seen, in tokens: more than 200,000 means a 1M-token window. */
  largest = 0;
  private readonly requests = new Set<string>();
  /** When the agent last produced output in the current turn, or undefined before any. */
  private lastOutput: number | undefined;
  /** The person interrupted the current turn. */
  private interrupted = false;
  /** The permission mode Claude Code last recorded. */
  private mode: string | undefined;
  /** Tool calls still waiting for their result: the agent is mid-turn. */
  private readonly waiting = new Set<string>();
  /**
   * A compaction that came while the agent had output in this turn: mid-turn
   * when the agent carries on, or at the next prompt (after the plugin saw the
   * prompt) when the turn had ended. Placed once the next entry shows which.
   */
  private pendingCompact: number | undefined;

  private endTurn(): void {
    if (this.lastOutput !== undefined) this.events.push({ kind: "turn_end", at: this.lastOutput, aborted: this.interrupted });
    this.lastOutput = undefined;
    this.interrupted = false;
  }

  private flushCompact(): void {
    if (this.pendingCompact !== undefined) this.events.push({ kind: "compact", at: this.pendingCompact });
    this.pendingCompact = undefined;
  }

  add(raw: unknown): void {
    const entry = obj(raw);
    if (entry === undefined) return;
    this.session ??= str(entry["sessionId"]) || undefined;
    if (entry["isSidechain"] === true) return;
    const mode = str(entry["permissionMode"]);
    if (mode !== undefined && mode !== "") this.mode = mode;
    const at = Date.parse(str(entry["timestamp"]) ?? "");
    if (!Number.isFinite(at)) return;
    const type = entry["type"];
    const message = obj(entry["message"]);

    if (type === "system") {
      if (entry["subtype"] !== "compact_boundary") return;
      // With no output since the last turn ended (a typed /compact), the compaction is simply next.
      if (this.lastOutput === undefined) this.events.push({ kind: "compact", at });
      else this.pendingCompact = at;
      return;
    }

    if (type === "user" && message !== undefined) {
      const content = message["content"];
      const blocks = Array.isArray(content) ? content.map(obj) : [];
      const results = blocks.filter((b) => b?.["type"] === "tool_result");
      if (results.length > 0) {
        this.flushCompact();
        for (const block of results) {
          const id = str(block?.["tool_use_id"]);
          if (id === undefined) continue;
          this.waiting.delete(id);
          this.events.push({ kind: "tool_result", at, id, ok: block?.["is_error"] !== true, text: textOf(block?.["content"]) });
        }
        return;
      }
      if (addedByClaudeCode(entry)) return;
      const text = textOf(content).replace(REMINDER, "").trim();
      const images = blocks.some((b) => b?.["type"] === "image");
      if (text === "" && !images) return;
      const prompt = typedPrompt(entry, text);
      // The person typed something (a prompt, an image, a command) or stopped the agent: the turn is over.
      // Anything else (a notification) ends it only when no tool call is still waiting for its result.
      const byPerson = prompt !== undefined || images || COMMAND.test(text) || INTERRUPTED.test(text);
      if (!byPerson && this.waiting.size > 0) return;
      if (this.lastOutput !== undefined && INTERRUPTED.test(text)) this.interrupted = true;
      this.waiting.clear();
      this.endTurn();
      if (prompt !== undefined) this.events.push({ kind: "prompt", at, text: prompt, images });
      this.flushCompact();
      return;
    }

    if (type === "assistant" && message !== undefined) {
      this.flushCompact();
      this.lastOutput = at;
      const usage = obj(message["usage"]);
      const request = str(entry["requestId"]) ?? str(message["id"]);
      if (usage !== undefined && (request === undefined || !this.requests.has(request))) {
        if (request !== undefined) this.requests.add(request);
        const tokens =
          count(usage["input_tokens"]) + count(usage["cache_read_input_tokens"]) + count(usage["cache_creation_input_tokens"]);
        if (tokens > 0) {
          this.largest = Math.max(this.largest, tokens);
          this.events.push({ kind: "context", at, tokens });
        }
      }
      const content = message["content"];
      if (!Array.isArray(content)) return;
      for (const block of content.map(obj)) {
        if (block?.["type"] !== "tool_use") continue;
        const id = str(block["id"]);
        const tool = str(block["name"]);
        if (id === undefined || tool === undefined) continue;
        this.waiting.add(id);
        this.events.push({
          kind: "tool_use",
          at,
          id,
          tool,
          input: obj(block["input"]) ?? {},
          ...(this.mode === undefined ? {} : { mode: this.mode }),
        });
      }
    }
  }

  /** The finished timeline: the last turn's end, and a compaction after it, are added. */
  finish(): TimelineEvent[] {
    this.endTurn();
    this.flushCompact();
    return this.events;
  }
}

/** The timeline of a session whose lines are already parsed. */
export function readTimeline(entries: readonly unknown[]): TimelineEvent[] {
  const builder = new TimelineBuilder();
  for (const entry of entries) builder.add(entry);
  return builder.finish();
}

/** The session id a transcript belongs to: the first sessionId in it, else the file name. */
export function sessionOf(entries: readonly unknown[], fileName: string): string {
  for (const raw of entries) {
    const id = str(obj(raw)?.["sessionId"]);
    if (id !== undefined && id !== "") return id;
  }
  return fileName.replace(/\.jsonl$/, "");
}

/** The context window a session ran with: Claude's requests never pass 200,000 tokens on a 200k window. */
export function inferWindow(largest: number): number {
  return largest > 200_000 ? 1_000_000 : 200_000;
}
