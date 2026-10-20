// decisions.lock: which thresholds apply, and how a probability becomes a band.
// Reading the file from disk is in lockfile.ts, so this module runs anywhere.
// Part of twosystems, created by Shashikant.
import type {
  Band,
  DecisionName,
  DecisionsLock,
  Engine as EngineInfo,
  LockDecision,
  Suggestion,
  Thresholds,
} from "./model.js";
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

/** Why a lock entry cannot be used for this engine and question, or null when it can. */
export function lockMismatch(
  entry: LockDecision | undefined,
  name: DecisionName,
  engine: EngineInfo,
  modelVersion?: string,
): string | null {
  if (entry === undefined) return "missing";
  if (entry.question_hash !== questionHash(QUESTIONS[name])) return "question";
  if (entry.engine.kind !== engine.kind || (entry.engine.model ?? "") !== (engine.model ?? "")) return "engine";
  // Thresholds fitted on one model version say nothing about another; when either side does not say, the lock is trusted.
  const fitted = entry.engine.model_version;
  if (fitted !== undefined && modelVersion !== undefined && fitted !== modelVersion) return "model_version";
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

const LOCK_ENGINES = new Set(["rules", "openrouter", "ollama", "llm"]);

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A decisions.lock read where the full schema validator cannot run (inside the
 * Claude Code plugin): the fields the thresholds depend on are checked by
 * hand, and anything doubtful gives null, so the built-in thresholds apply.
 * The twosystems command validates every field with the JSON Schema instead.
 */
export function asLock(value: unknown): DecisionsLock | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const lock = value as Record<string, unknown>;
  if (lock["lock_version"] !== 1 || typeof lock["created_at"] !== "string" || typeof lock["created_by"] !== "string") return null;
  const holdout = lock["holdout_rate"];
  if (typeof holdout !== "number" || !(holdout >= 0 && holdout <= 0.5)) return null;
  const decisions = lock["decisions"];
  if (typeof decisions !== "object" || decisions === null || Array.isArray(decisions)) return null;
  const names = Object.keys(decisions);
  if (names.length === 0 || names.some((n) => n !== "stuck" && n !== "fresh_start")) return null;
  for (const entry of Object.values(decisions as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return null;
    const d = entry as Record<string, unknown>;
    const engine = d["engine"] as Record<string, unknown> | undefined;
    if (typeof engine !== "object" || engine === null || !LOCK_ENGINES.has(String(engine["kind"]))) return null;
    if (engine["model"] !== undefined && typeof engine["model"] !== "string") return null;
    if (typeof d["question_hash"] !== "string") return null;
    const labels = d["labels"];
    if (!Array.isArray(labels) || labels.length < 2 || labels.some((l) => typeof l !== "string")) return null;
    if (typeof d["calibration"] !== "object" || d["calibration"] === null) return null;
    const target = d["target_false_alarm"];
    if (typeof target !== "number" || !(target > 0 && target <= 0.5)) return null;
    const thresholds = d["thresholds"];
    if (typeof thresholds !== "object" || thresholds === null || Object.keys(thresholds).length === 0) return null;
    for (const [label, limits] of Object.entries(thresholds as Record<string, unknown>)) {
      if (!labels.includes(label) || typeof limits !== "object" || limits === null) return null;
      const { act, unsure } = limits as Record<string, unknown>;
      if (!isProbability(act) || !isProbability(unsure) || unsure > act) return null;
    }
  }
  return value as DecisionsLock;
}
