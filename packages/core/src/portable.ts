// The part of the core that runs anywhere JavaScript runs: no Node modules,
// no file system, no process. The Claude Code plugin carries a copy of these
// files (made by scripts/sync-shared.mjs) and runs them inside Claude Code.
// Everything that touches disk, the network or the process lives elsewhere and
// is passed in. A test fails if anything in this module's imports reaches Node.
// Part of twosystems, created by Shashikant.
export * from "./model.js";
export { sha256, sha256Hex } from "./hash.js";
export { isToken, newId, secureRandom, timestamp } from "./ids.js";
export { type DecisionQuestion, LABEL_SUGGESTION, QUESTIONS, labelsOf, questionHash } from "./questions.js";
export {
  DEFAULT_HOLDOUT_RATE,
  type LoadedLock,
  type Thresholded,
  applyThresholds,
  asLock,
  builtInLock,
  defaultLock,
  lockHash,
  lockMismatch,
} from "./lock.js";
export {
  type FreshStartInput,
  type FreshStartSignal,
  type Observation,
  SIGNAL_RULES,
  type SignalName,
  type StuckSignal,
  contentWords,
  errorFingerprint,
  freshStartSignals,
  normalizeCommand,
  promptOverlap,
  stuckSignals,
} from "./signals.js";
export { REDACTED, clip, looksRandom, redact, redactAndClip, wellFormed } from "./redact.js";
export { STATE_LIMITS, type State, type StateInput, buildState } from "./state.js";
export {
  type DecisionEngine,
  type EngineAnswer,
  EngineError,
  type EngineFailure,
  type FetchLike,
  type FetchResponseLike,
  platformFetch,
} from "./engines/types.js";
export { DEFAULT_OPENROUTER_MODEL, OPENROUTER_URL, OpenRouterEngine, decisionsBody, parseDecisionsResponse } from "./engines/openrouter.js";
export { OllamaEngine, isLocalHost } from "./engines/ollama.js";
export { RulesEngine, freshStartProbabilities, stuckProbabilities } from "./engines/rules.js";
export { type Evaluation, type EvaluateInput, evaluate, sessionToken } from "./pipeline.js";
export {
  type Interval,
  type Receipt,
  RECEIPT_RULES,
  bootstrapSaving,
  buildReceipt,
  requestTokens,
  seededRandom,
} from "./receipt.js";
export { SIGNAL_TEXT, describe, freshStartMessage, stuckMessage, thousands } from "./messages.js";
export { OBSERVATION_LIMITS, isEditTool, rememberIn, shorten, storable, toolCommand, toolFiles } from "./observations.js";
export { type RecordSource, type RequestUsage, exactUsageRecord, userActionRecord } from "./records.js";
export { formatReceipt, money } from "./receipttext.js";
