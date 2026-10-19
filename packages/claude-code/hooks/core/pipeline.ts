// One decision, start to finish: signals, state, System 1, thresholds, holdout,
// and the event record. Failures never block the user: they become a silent
// "not_evaluated" record.
// Part of twosystems, created by Shashikant.
import type { Agent, Decision, DecisionName, Suggestion, TwoSystemsEvent } from "./model.js";
import type { DecisionEngine } from "./engines/types.js";
import { EngineError } from "./engines/types.js";
import { isToken, newId, secureRandom, timestamp } from "./ids.js";
import { type LoadedLock, applyThresholds, defaultLock, lockMismatch } from "./lock.js";
import { QUESTIONS, sha256 } from "./questions.js";
import { type Observation, type SignalName, freshStartSignals, stuckSignals } from "./signals.js";
import { buildState } from "./state.js";

export interface EvaluateInput {
  name: DecisionName;
  /** What happened in the session so far, in time order. */
  observations: readonly Observation[];
  /** For fresh_start: the prompt about to be sent. */
  newPrompt?: string;
  now: number;
  engine: DecisionEngine;
  lock: LoadedLock;
  holdoutRate: number;
  timeoutMs: number;
  cacheTtlSeconds: number;
  agent: Agent;
  session: string;
  agentVersion?: string;
  adapterVersion?: string;
  /** Random number in [0, 1). Defaults to a cryptographic source; tests pass a fixed one. */
  random?: () => number;
  /**
   * Starts the timeout: calls onTimeout after ms and returns a function that
   * cancels it. Defaults to the platform's setTimeout; the Claude Code plugin
   * passes its host clock.
   */
  startTimer?: (ms: number, onTimeout: () => void) => () => void;
}

export interface Evaluation {
  signals: SignalName[];
  /** The decision record to append to the event log. Absent when no signal fired. */
  event?: TwoSystemsEvent & { type: "decision" };
  /** What to show the user. Absent when twosystems stays silent. */
  show?: Suggestion;
}

interface PlatformTimers {
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** The platform's own timer, where there is one. Without it, no timeout is set. */
function platformTimer(ms: number, onTimeout: () => void): () => void {
  const timers = globalThis as PlatformTimers;
  if (timers.setTimeout === undefined) return () => undefined;
  const handle = timers.setTimeout(onTimeout, ms);
  return () => timers.clearTimeout?.(handle);
}

/** A session id that fits the event schema: kept when it is a plain token, hashed otherwise. */
export function sessionToken(session: string): string {
  if (isToken(session)) return session;
  return `s-${sha256(session).slice("sha256:".length, "sha256:".length + 16)}`;
}

// Resolves with the engine's answer, or rejects with a timeout when the signal
// fires, even if the engine itself ignores the signal.
function withTimeout<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new EngineError("timeout", "The decision model did not answer in time."));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Run one decision. Never throws for engine problems; they are recorded as not_evaluated. */
export async function evaluate(input: EvaluateInput): Promise<Evaluation> {
  const signals: SignalName[] =
    input.name === "stuck"
      ? stuckSignals(input.observations)
      : freshStartSignals({
          observations: input.observations,
          prompt: input.newPrompt ?? "",
          now: input.now,
          cacheTtlSeconds: input.cacheTtlSeconds,
        });
  if (signals.length === 0) return { signals };

  const question = QUESTIONS[input.name];
  const state = buildState({
    name: input.name,
    observations: input.observations,
    signals,
    ...(input.newPrompt === undefined ? {} : { newPrompt: input.newPrompt }),
    now: input.now,
  });

  const engine: Decision["engine"] = { kind: input.engine.info.kind };
  if (input.engine.info.model !== undefined && isToken(input.engine.info.model)) engine.model = input.engine.info.model;
  const decision: Decision = {
    name: input.name,
    engine,
    state_hash: state.hash,
    signals: [...signals],
    band: "not_evaluated",
    holdout: false,
  };

  const started = performance.now();
  const controller = new AbortController();
  const cancelTimer = (input.startTimer ?? platformTimer)(input.timeoutMs, () => controller.abort());
  try {
    const answer = await withTimeout(
      input.engine.decide({ question, state: state.lines, signals, signal: controller.signal }),
      controller.signal,
    );
    decision.latency_ms = round(performance.now() - started, 1);
    if (answer.modelVersion !== undefined && isToken(answer.modelVersion)) {
      decision.engine.model_version = answer.modelVersion;
    }
    if (answer.costUsd !== undefined) decision.cost_usd = answer.costUsd;
    decision.probabilities = Object.fromEntries(
      Object.entries(answer.probabilities).map(([label, p]) => [label, round(Math.min(1, Math.max(0, p)), 4)]),
    );

    // Use the fitted thresholds only when they were fitted for this engine and this exact question.
    const entry = input.lock.lock.decisions[input.name];
    const mismatch = lockMismatch(entry, input.name, input.engine.info);
    const thresholds =
      mismatch === null && entry !== undefined
        ? entry.thresholds
        : (defaultLock(input.engine.info).decisions[input.name]?.thresholds ?? {});
    decision.lock_hash = input.lock.hash;
    if (mismatch !== null && input.lock.source !== "built-in") decision.reason = "lock_mismatch";

    const { band, suggestion } = applyThresholds(answer.probabilities, thresholds);
    decision.band = band;
    if (suggestion !== undefined) decision.suggestion = suggestion;
  } catch (error) {
    decision.latency_ms = round(performance.now() - started, 1);
    decision.reason = error instanceof EngineError ? error.reason : controller.signal.aborted ? "timeout" : "engine_error";
  } finally {
    cancelTimer();
  }

  // The holdout applies to every moment that would have shown something.
  let show: Suggestion | undefined;
  if (decision.band === "act" && decision.suggestion !== undefined) {
    if ((input.random ?? secureRandom)() < input.holdoutRate) {
      decision.holdout = true;
      decision.reason = "holdout";
    } else {
      show = decision.suggestion;
    }
  }

  const event: TwoSystemsEvent & { type: "decision" } = {
    v: 1,
    id: newId(),
    ts: timestamp(input.now),
    type: "decision",
    agent: input.agent,
    session: sessionToken(input.session),
    decision,
  };
  if (input.agentVersion !== undefined && isToken(input.agentVersion)) event.agent_version = input.agentVersion;
  if (input.adapterVersion !== undefined && isToken(input.adapterVersion)) event.adapter_version = input.adapterVersion;
  return show === undefined ? { signals, event } : { signals, event, show };
}
