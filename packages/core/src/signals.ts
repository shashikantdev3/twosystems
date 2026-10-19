// Signals: cheap facts computed from what the agent did, with no model involved.
// Most moments stop here. A decision model is asked only when a signal fires.
// Part of twosystems, created by Shashikant.

/** One thing that happened in a session, as reported by an adapter. Times are milliseconds since 1970. */
export type Observation =
  | { kind: "prompt"; at: number; text: string }
  | {
      kind: "tool";
      at: number;
      /** Tool name as the agent reports it, for example "bash" or "edit". */
      tool: string;
      /** The shell command, when the tool ran one. */
      command?: string;
      ok: boolean;
      /** First part of the error output when the call failed. */
      error?: string;
      /** Files the call changed. */
      files?: string[];
    }
  | { kind: "context"; at: number; tokens: number; window?: number };

export type StuckSignal =
  | "repeated_command"
  | "repeated_error"
  | "no_file_change"
  | "many_tool_calls";
export type FreshStartSignal = "large_context" | "cache_expired" | "new_prompt_low_overlap";
export type SignalName = StuckSignal | FreshStartSignal;

/** Thresholds for the rule signals. Plain numbers so they can be tuned and tested. */
export const SIGNAL_RULES = {
  /** How many recent tool calls the stuck signals look at. */
  window: 10,
  /** Times the same failing command must appear in the window. */
  repeatedCommand: 3,
  /** Times the same error must appear in the window. */
  repeatedError: 3,
  /** Tool calls in a row with no file changed. */
  noFileChange: 10,
  /** Tool calls since the last prompt. */
  manyToolCalls: 40,
  /** Share of the context window that counts as large. */
  largeContextShare: 0.5,
  /** Context size that counts as large when the window is unknown. */
  largeContextTokens: 100_000,
  /** Below this size a fresh start saves too little to be worth a suggestion. */
  minContextForFreshStart: 20_000,
  /** Word overlap between the new prompt and recent prompts that counts as a new topic. */
  lowOverlap: 0.1,
  /** A new prompt needs at least this many distinct words for the overlap test. */
  minPromptWords: 4,
} as const;

/** Collapse whitespace so the same command typed twice compares equal. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").slice(0, 500);
}

// Lines that say a command failed without saying why. They are skipped when
// picking the line that identifies an error.
const GENERIC_ERROR_LINE = /^(?:exit code:? ?\d+|command (?:failed|exited)\b.*|error:?|failed:?|traceback \(most recent call last\):?)$/i;
const SPECIFIC_ERROR_LINE = /error|exception|fail|cannot|can't|not found|denied|undefined|panic|refused|timed? ?out/i;

/**
 * Reduce an error to a fingerprint that stays the same across runs: the most
 * telling line (one that names an error, else the first line with content),
 * lower case, with numbers, hex, paths and quoted text replaced by placeholders.
 */
export function errorFingerprint(error: string): string {
  const lines = error
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const useful = lines.filter((l) => !GENERIC_ERROR_LINE.test(l));
  const line = useful.find((l) => SPECIFIC_ERROR_LINE.test(l)) ?? useful[0] ?? lines[0] ?? "";
  return line
    .toLowerCase()
    .replace(/(["'`]).*?\1/g, "<s>")
    .replace(/(?:[a-z]:)?[\\/][^\s:]+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function toolCalls(observations: readonly Observation[]): Extract<Observation, { kind: "tool" }>[] {
  return observations.filter((o): o is Extract<Observation, { kind: "tool" }> => o.kind === "tool");
}

function highestCount(values: string[]): number {
  const counts = new Map<string, number>();
  let best = 0;
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    best = Math.max(best, next);
  }
  return best;
}

/** Signals that the agent may be stuck. Observations must be in time order. */
export function stuckSignals(observations: readonly Observation[]): StuckSignal[] {
  const signals: StuckSignal[] = [];
  const lastPrompt = observations.findLastIndex((o) => o.kind === "prompt");
  const sincePrompt = toolCalls(observations.slice(lastPrompt + 1));
  const recent = sincePrompt.slice(-SIGNAL_RULES.window);

  const failedCommands = recent.filter((c) => !c.ok && c.command).map((c) => normalizeCommand(c.command ?? ""));
  if (highestCount(failedCommands) >= SIGNAL_RULES.repeatedCommand) signals.push("repeated_command");

  const errors = recent.filter((c) => !c.ok && c.error).map((c) => errorFingerprint(c.error ?? ""));
  if (highestCount(errors.filter((e) => e.length > 0)) >= SIGNAL_RULES.repeatedError) signals.push("repeated_error");

  const tail = sincePrompt.slice(-SIGNAL_RULES.noFileChange);
  if (tail.length >= SIGNAL_RULES.noFileChange && tail.every((c) => (c.files ?? []).length === 0)) {
    signals.push("no_file_change");
  }

  if (sincePrompt.length >= SIGNAL_RULES.manyToolCalls) signals.push("many_tool_calls");
  return signals;
}

const STOP_WORDS = new Set(
  "a again also an and any are as at be but by can do does for from has have here how i if in into is it its just me my no not now of on or our please so still that the then there this to too us was we what when where which why will with you your".split(
    " ",
  ),
);

/** Distinct lower-case words of three or more letters, without common filler words. */
export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  return new Set(words.filter((w) => !STOP_WORDS.has(w)));
}

/** Share of the new prompt's words that already appeared in the earlier prompts, from 0 to 1. */
export function promptOverlap(newPrompt: string, earlierPrompts: readonly string[]): number {
  const fresh = contentWords(newPrompt);
  if (fresh.size === 0) return 1;
  const seen = new Set<string>();
  for (const prompt of earlierPrompts) for (const word of contentWords(prompt)) seen.add(word);
  let shared = 0;
  for (const word of fresh) if (seen.has(word)) shared += 1;
  return shared / fresh.size;
}

export interface FreshStartInput {
  /** Everything before the new prompt, in time order. */
  observations: readonly Observation[];
  /** The prompt the user is about to send. */
  prompt: string;
  /** When the prompt was submitted. */
  now: number;
  /** How long the model provider keeps the prompt cache, in seconds. */
  cacheTtlSeconds: number;
}

/** Signals that starting fresh may help before the new prompt is sent. */
export function freshStartSignals(input: FreshStartInput): FreshStartSignal[] {
  const { observations, prompt, now, cacheTtlSeconds } = input;
  const context = observations.findLast((o) => o.kind === "context");
  const tokens = context?.kind === "context" ? context.tokens : 0;
  if (tokens < SIGNAL_RULES.minContextForFreshStart) return [];

  const signals: FreshStartSignal[] = [];
  const window = context?.kind === "context" ? context.window : undefined;
  const large =
    window !== undefined && window > 0
      ? tokens / window >= SIGNAL_RULES.largeContextShare
      : tokens >= SIGNAL_RULES.largeContextTokens;
  if (large) signals.push("large_context");

  const last = observations.at(-1);
  if (last !== undefined && now - last.at >= cacheTtlSeconds * 1000) signals.push("cache_expired");

  const earlier = observations.filter((o) => o.kind === "prompt").map((o) => (o.kind === "prompt" ? o.text : ""));
  if (earlier.length > 0 && contentWords(prompt).size >= SIGNAL_RULES.minPromptWords) {
    if (promptOverlap(prompt, earlier.slice(-5)) < SIGNAL_RULES.lowOverlap) signals.push("new_prompt_low_overlap");
  }
  return signals;
}
