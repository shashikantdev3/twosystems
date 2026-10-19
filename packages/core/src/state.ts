// State builder: a short, redacted summary of the moment for the decision model.
// This summary is the only part of a session that leaves the machine, and only
// when a remote engine is used. The event log keeps just its hash.
// Part of twosystems, created by Shashikant.
import type { DecisionName } from "./model.js";
import { sha256 } from "./questions.js";
import { redact, redactAndClip } from "./redact.js";
import type { Observation, SignalName } from "./signals.js";

/** Limits that keep the summary small: about 600 tokens at most. */
export const STATE_LIMITS = {
  promptChars: 400,
  commandChars: 160,
  errorChars: 200,
  toolCalls: 8,
  totalChars: 2400,
} as const;

export interface StateInput {
  name: DecisionName;
  observations: readonly Observation[];
  signals: readonly SignalName[];
  /** The prompt about to be sent, for the fresh-start question. */
  newPrompt?: string;
  now: number;
}

export interface State {
  /** Lines sent to the decision model as the "state" of the decisions API. */
  lines: string[];
  /** sha256 of the lines, stored in the event log instead of the text. */
  hash: string;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`;
}

function describeTool(call: Extract<Observation, { kind: "tool" }>): string {
  const what = call.command ? `${call.tool}: ${redactAndClip(call.command, STATE_LIMITS.commandChars)}` : call.tool;
  const n = call.files?.length ?? 0;
  const files = n > 0 ? ` (changed ${n} file${n === 1 ? "" : "s"})` : "";
  if (call.ok) return `${what} -> ok${files}`;
  const error = call.error ? `: ${redactAndClip(call.error, STATE_LIMITS.errorChars)}` : "";
  return `${what} -> failed${error}${files}`;
}

interface Line {
  text: string;
  /** Lower numbers are kept first when the summary is too long. */
  priority: number;
}

/**
 * Build the redacted summary and its hash. Pure: the same input gives the same
 * output. When everything does not fit, the signals, the new prompt, the size
 * and the newest tool calls are kept first, and older detail is dropped.
 */
export function buildState(input: StateInput): State {
  const { observations, now } = input;
  const prompts = observations.filter((o): o is Extract<Observation, { kind: "prompt" }> => o.kind === "prompt");
  const lines: Line[] = [];

  const first = prompts[0];
  const last = prompts.at(-1);
  if (first !== undefined) lines.push({ text: `Task at the start: ${redactAndClip(first.text, STATE_LIMITS.promptChars)}`, priority: 30 });
  if (last !== undefined && last !== first) {
    lines.push({ text: `Latest prompt: ${redactAndClip(last.text, STATE_LIMITS.promptChars)}`, priority: 20 });
  }
  if (input.newPrompt !== undefined) {
    lines.push({ text: `New prompt: ${redactAndClip(input.newPrompt, STATE_LIMITS.promptChars)}`, priority: 2 });
  }

  const lastPrompt = observations.findLastIndex((o) => o.kind === "prompt");
  const calls = observations
    .slice(lastPrompt + 1)
    .filter((o): o is Extract<Observation, { kind: "tool" }> => o.kind === "tool");
  if (calls.length > 0) {
    const shown = calls.slice(-STATE_LIMITS.toolCalls);
    lines.push({ text: `Tool calls since the latest prompt: ${calls.length}. The last ${shown.length}, oldest first:`, priority: 5 });
    shown.forEach((call, i) => lines.push({ text: `- ${describeTool(call)}`, priority: 10 + (shown.length - i) }));
  }

  const context = observations.findLast((o) => o.kind === "context");
  if (context?.kind === "context") {
    const share = context.window ? ` (${Math.round((100 * context.tokens) / context.window)}% of the window)` : "";
    lines.push({ text: `Conversation size: ${context.tokens} tokens${share}.`, priority: 3 });
  }
  const lastSeen = observations.at(-1);
  if (lastSeen !== undefined) lines.push({ text: `Time since the last activity: ${minutes(now - lastSeen.at)}.`, priority: 4 });
  if (input.signals.length > 0) lines.push({ text: `Rule signals: ${input.signals.join(", ")}.`, priority: 1 });

  // A second pass catches anything that only looks like a secret once a line is put together.
  const ready = lines.map((line, index) => ({ ...line, text: redact(line.text), index }));
  const kept = new Set<number>();
  let total = 0;
  for (const line of [...ready].sort((a, b) => a.priority - b.priority || a.index - b.index)) {
    if (total + line.text.length > STATE_LIMITS.totalChars) continue;
    kept.add(line.index);
    total += line.text.length;
  }
  const result = ready.filter((line) => kept.has(line.index)).map((line) => line.text);
  return { lines: result, hash: sha256(JSON.stringify(result)) };
}
