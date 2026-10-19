// decisions.lock: which thresholds apply, and how a probability becomes a band.
// Part of twosystems, created by Shashikant.
import { readFile } from "node:fs/promises";
import type {
  Band,
  DecisionName,
  DecisionsLock,
  Engine as EngineInfo,
  LockDecision,
  Suggestion,
  Thresholds,
} from "./contracts.js";
import { MAX_LOCK_BYTES, validateLockText } from "./contracts.js";
import { LABEL_SUGGESTION, QUESTIONS, labelsOf, questionHash, sha256 } from "./questions.js";

/**
 * Built-in thresholds, used until a fitted decisions.lock exists. They are
 * cautious guesses, not fitted on data. Decision models get one set and the
 * rules engine another, because the rules engine gives coarse probabilities.
 */
const DEFAULT_THRESHOLDS: Record<"model" | "rules", Record<DecisionName, Record<string, Thresholds>>> = {
  model: {
    stuck: { stuck: { act: 0.9, unsure: 0.7 } },
    fresh_start: { clear: { act: 0.85, unsure: 0.6 }, compact: { act: 0.9, unsure: 0.7 } },
  },
  rules: {
    stuck: { stuck: { act: 0.85, unsure: 0.6 } },
    fresh_start: { clear: { act: 0.75, unsure: 0.6 }, compact: { act: 0.75, unsure: 0.6 } },
  },
};

export const DEFAULT_HOLDOUT_RATE = 0.1;

/** A decisions.lock that ships with the package for the given engine. */
export function defaultLock(engine: EngineInfo): DecisionsLock {
  const table = DEFAULT_THRESHOLDS[engine.kind === "rules" ? "rules" : "model"];
  const decision = (name: DecisionName): LockDecision => ({
    engine: { ...engine },
    question_hash: questionHash(QUESTIONS[name]),
    labels: labelsOf(QUESTIONS[name]),
    calibration: { method: "none" },
    thresholds: table[name],
    target_false_alarm: 0.05,
  });
  return {
    lock_version: 1,
    created_at: "2026-10-19T00:00:00Z",
    created_by: "twosystems built-in defaults, not fitted on data",
    holdout_rate: DEFAULT_HOLDOUT_RATE,
    decisions: { stuck: decision("stuck"), fresh_start: decision("fresh_start") },
  };
}

export interface LoadedLock {
  lock: DecisionsLock;
  /** sha256 of the lock, stored with every decision so receipts can tell threshold sets apart. */
  hash: string;
  /** Where it came from: a file path, or "built-in". */
  source: string;
}

/** Hash of a lock object, independent of how its file was formatted. */
export function lockHash(lock: DecisionsLock): string {
  return sha256(JSON.stringify(lock));
}

export function builtInLock(engine: EngineInfo): LoadedLock {
  const lock = defaultLock(engine);
  return { lock, hash: lockHash(lock), source: "built-in" };
}

/**
 * Read and validate a decisions.lock file. Returns null when the file does not
 * exist; throws an Error listing the problems when it is invalid.
 */
export async function readLock(path: string): Promise<LoadedLock | null> {
  let text: string;
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_LOCK_BYTES + 3) throw new Error(`${path} is longer than ${MAX_LOCK_BYTES} bytes`);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const result = validateLockText(text);
  if (!result.ok) throw new Error(`${path} is not a valid decisions.lock: ${result.errors.slice(0, 5).join("; ")}`);
  const lock = JSON.parse(text.replace(/^﻿/, "")) as DecisionsLock;
  return { lock, hash: lockHash(lock), source: path };
}

/** Why a lock entry cannot be used for this engine and question, or null when it can. */
export function lockMismatch(entry: LockDecision | undefined, name: DecisionName, engine: EngineInfo): string | null {
  if (entry === undefined) return "missing";
  if (entry.question_hash !== questionHash(QUESTIONS[name])) return "question";
  if (entry.engine.kind !== engine.kind || (entry.engine.model ?? "") !== (engine.model ?? "")) return "engine";
  return null;
}

export interface Thresholded {
  band: Exclude<Band, "not_evaluated">;
  suggestion?: Suggestion;
}

/**
 * Turn probabilities into a band. Labels with thresholds are checked from the
 * most likely down: the first that reaches its act threshold gives "act"; if
 * none does, the first that reaches its unsure threshold gives "unsure";
 * otherwise the band is "silent".
 */
export function applyThresholds(
  probabilities: Readonly<Record<string, number>>,
  thresholds: Readonly<Record<string, Thresholds>>,
): Thresholded {
  const ranked = Object.keys(thresholds)
    .filter((label) => LABEL_SUGGESTION[label] !== undefined)
    .sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0) || (a < b ? -1 : 1));
  for (const level of ["act", "unsure"] as const) {
    for (const label of ranked) {
      const limit = thresholds[label]?.[level];
      if (limit !== undefined && (probabilities[label] ?? 0) >= limit) {
        const suggestion = LABEL_SUGGESTION[label];
        return suggestion === undefined ? { band: level } : { band: level, suggestion };
      }
    }
  }
  return { band: "silent" };
}
