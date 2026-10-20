// What the plugin says, in plain words. Part of twosystems, created by Shashikant.
import {
  type DecisionName,
  type DecisionsLock,
  type Engine,
  type SignalName,
  describe,
  lockMismatch,
  money,
  thousands,
} from "../core/portable.js";
import type { Settings } from "./settings.js";
import type { Activity } from "./tracker.js";

/** The reason shown in Claude Code's permission dialog when the agent seems stuck. */
export function stuckReason(signals: readonly SignalName[]): string {
  return `twosystems: the agent may be stuck (${describe(signals)}). Yes lets this step run. No stops here so you can tell Claude what to try instead.`;
}

/** The band's sentence for a fresh-start suggestion. */
export function bandMessage(suggestion: "clear" | "compact", signals: readonly SignalName[], tokens: number, held: boolean): string {
  const size = tokens > 0 ? ` The conversation holds about ${thousands(tokens)} tokens, sent again with every request.` : "";
  const why = describe(signals);
  const advice = held
    ? suggestion === "clear"
      ? "Clearing first would start this task fresh."
      : "Compacting first would keep a short summary and drop the rest."
    : suggestion === "clear"
      ? "Before your next prompt, clearing would start fresh."
      : "Before your next prompt, compacting would keep a short summary and drop the rest.";
  return `twosystems: ${why.charAt(0).toUpperCase()}${why.slice(1)}.${size} ${advice}`;
}

/** A held prompt, shortened for the band. */
export function excerpt(prompt: string, max = 90): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/** The line under an answer, or null when twosystems did nothing worth a line this turn. */
export function receiptLine(
  turn: Activity,
  totals: { checks: number; costUsd: number },
  saving: { action: "clear" | "compact"; before: number; after: number } | null,
): string | null {
  const parts: string[] = [];
  if (saving !== null && saving.before > saving.after) {
    const verb = saving.action === "clear" ? "clearing" : "compacting";
    parts.push(`after ${verb}, each request sends about ${thousands(saving.after)} tokens instead of ${thousands(saving.before)}`);
  }
  if (turn.checks > 0) {
    const what = turn.asked > 0 ? "asked before a step" : turn.shown > 0 ? "suggested a fresh start" : "checked quietly";
    parts.push(`${what} (${turn.checks} ${turn.checks === 1 ? "check" : "checks"}, ${money(turn.costUsd)})`);
  }
  if (parts.length === 0) return null;
  const session = totals.checks > 0 ? ` This session: ${totals.checks} ${totals.checks === 1 ? "check" : "checks"}, ${money(totals.costUsd)}.` : "";
  return `twosystems: ${parts.join("; ")}.${session}`;
}

const MISMATCH: Record<string, string> = {
  missing: "not in the lock, built-in thresholds",
  question: "fitted for an older wording of its question, built-in thresholds",
  engine: "fitted for another engine, built-in thresholds",
};

/** Which decisions a fitted lock applies to with the engine in use, and why not for the others. */
function fittedText(fitted: { lock: DecisionsLock; engine: Engine }): string {
  const names: DecisionName[] = ["stuck", "fresh_start"];
  const parts = names.map((name) => {
    const entry = fitted.lock.decisions[name];
    const why = lockMismatch(entry, name, fitted.engine);
    if (why !== null) return `${name} ${MISMATCH[why] ?? "built-in thresholds"}`;
    const version = entry?.engine.model_version;
    return `${name} fitted${version === undefined ? "" : ` (built-in thresholds when the model version is not ${version})`}`;
  });
  return `Thresholds:        decisions.lock from ${fitted.lock.created_at}: ${parts.join("; ")}. The false-alarm level setting is not used.`;
}

/** The settings and state, for /twosystems. */
export function statusText(
  settings: Settings,
  engineLabel: string,
  remote: boolean,
  totals: { checks: number; costUsd: number; asked: number; shown: number },
  warnings: readonly string[],
  fitted: { lock: DecisionsLock; engine: Engine } | null = null,
): string {
  const thresholds = fitted === null ? `False-alarm level: ${settings.falseAlarmBudget} (built-in thresholds, not yet fitted on data)` : fittedText(fitted);
  const lines = [
    "twosystems for Claude Code",
    `Engine:            ${engineLabel}${remote ? " (sends a short redacted summary off this machine)" : " (stays on this machine)"}`,
    thresholds,
    `Holdout:           ${settings.holdoutRate}`,
    `Cache lifetime:    ${settings.cacheTtlSeconds / 60} minutes`,
    `This session:      ${totals.checks} checks, ${totals.asked} asked before a step, ${totals.shown} fresh-start suggestions, ${money(totals.costUsd)}`,
  ];
  for (const warning of warnings) lines.push(`Note: ${warning}`);
  return lines.join("\n");
}
