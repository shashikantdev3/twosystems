// The "rules" engine: no model at all. It turns rule signals into rough,
// hand-set probabilities, so twosystems still works with no key and nothing
// leaves the machine. These numbers are not fitted on data.
// Part of twosystems, created by Shashikant.
import type { DecisionQuestion } from "../questions.js";
import { labelsOf } from "../questions.js";
import type { SignalName } from "../signals.js";
import { type DecisionEngine, type EngineAnswer, normalize } from "./types.js";

/** How strongly each signal points to "stuck". Each unit halves the chance of "progressing". */
const STUCK_WEIGHT: Partial<Record<SignalName, number>> = {
  repeated_error: 1.5,
  repeated_command: 1.5,
  no_file_change: 1,
  many_tool_calls: 0.5,
};

/** Probabilities for the stuck question from its signals. */
export function stuckProbabilities(signals: readonly SignalName[]): Record<string, number> {
  const strength = signals.reduce((sum, s) => sum + (STUCK_WEIGHT[s] ?? 0), 0);
  const stuck = 1 - 0.5 ** strength;
  return { progressing: 1 - stuck, stuck };
}

/** Probabilities for the fresh-start question from its signals, strongest case first. */
export function freshStartProbabilities(signals: readonly SignalName[]): Record<string, number> {
  const has = (s: SignalName) => signals.includes(s);
  if (has("new_prompt_low_overlap")) return { continue: 0.1, compact: 0.1, clear: 0.8 };
  if (has("large_context") && has("cache_expired")) return { continue: 0.15, compact: 0.8, clear: 0.05 };
  if (has("large_context")) return { continue: 0.35, compact: 0.65, clear: 0 };
  if (has("cache_expired")) return { continue: 0.45, compact: 0.55, clear: 0 };
  return { continue: 1, compact: 0, clear: 0 };
}

export class RulesEngine implements DecisionEngine {
  readonly info = { kind: "rules" as const };
  readonly remote = false;

  decide(request: { question: DecisionQuestion; signals: readonly SignalName[] }): Promise<EngineAnswer> {
    const raw =
      request.question.name === "stuck" ? stuckProbabilities(request.signals) : freshStartProbabilities(request.signals);
    return Promise.resolve({ probabilities: normalize(raw, labelsOf(request.question)) });
  }
}
