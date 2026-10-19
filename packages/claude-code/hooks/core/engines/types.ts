// What every decision engine provides, and how engines report failure.
// Part of twosystems, created by Shashikant.
import type { Engine as EngineInfo } from "../model.js";
import type { DecisionQuestion } from "../questions.js";
import type { SignalName } from "../signals.js";

export interface EngineAnswer {
  /** Probability per label of the question. Sums to 1. */
  probabilities: Record<string, number>;
  /** Exact model version that answered, when the provider reports it. */
  modelVersion?: string;
  /** Cost of this call in US dollars, when known. */
  costUsd?: number;
}

export interface DecisionEngine {
  /** Engine as recorded in the event log and in decisions.lock. */
  readonly info: EngineInfo;
  /** True when the engine sends the summary off this machine. */
  readonly remote: boolean;
  decide(request: {
    question: DecisionQuestion;
    state: readonly string[];
    signals: readonly SignalName[];
    signal: AbortSignal;
  }): Promise<EngineAnswer>;
}

/** The part of an HTTP response an engine reads. Node's fetch Response fits it. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/**
 * How an engine makes its one POST request. Node's global fetch fits it; the
 * Claude Code plugin passes its host's fetch instead.
 */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

/** The platform's fetch where there is one (Node 18 and newer). */
export function platformFetch(): FetchLike | undefined {
  return (globalThis as { fetch?: FetchLike }).fetch;
}

/** Why an engine gave no answer. Stored as the decision's reason code. */
export type EngineFailure = "no_key" | "no_model" | "timeout" | "network" | "http_error" | "bad_response";

export class EngineError extends Error {
  readonly reason: EngineFailure;
  readonly status?: number;
  constructor(reason: EngineFailure, message: string, status?: number) {
    super(message);
    this.name = "EngineError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

/** Scale non-negative weights so they sum to 1. Equal shares when every weight is zero. */
export function normalize(weights: Record<string, number>, labels: readonly string[]): Record<string, number> {
  const clean: Record<string, number> = {};
  let sum = 0;
  for (const label of labels) {
    const w = weights[label];
    const v = typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;
    clean[label] = v;
    sum += v;
  }
  for (const label of labels) clean[label] = sum > 0 ? (clean[label] ?? 0) / sum : 1 / labels.length;
  return clean;
}
