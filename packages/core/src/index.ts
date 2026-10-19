// twosystems core, created by Shashikant.
// https://github.com/shashikantdev3/twosystems
export { VERSION } from "./version.js";

export {
  MAX_DEPTH,
  MAX_EVENT_BYTES,
  MAX_EVENT_VALUES,
  MAX_LOCK_BYTES,
  MAX_LOCK_VALUES,
  isDateTime,
  isWellFormed,
  isUuid,
  parseJson,
  validateEvent,
  validateEventText,
  validateEventsJsonl,
  validateLock,
  validateLockText,
  type Agent,
  type Band,
  type Decision,
  type DecisionName,
  type DecisionsLock,
  type Engine,
  type EngineKind,
  type LockDecision,
  type Suggestion,
  type Thresholds,
  type TwoSystemsEvent,
  type Usage,
  type UserAction,
  type UserActionKind,
  type ValidationResult,
} from "./contracts.js";

export { type Config, cacheTtlFor, readConfig } from "./config.js";
export {
  DEFAULT_OPENROUTER_MODEL,
  type DecisionEngine,
  type EngineAnswer,
  EngineError,
  type EngineFailure,
  OllamaEngine,
  OpenRouterEngine,
  RulesEngine,
  createEngine,
} from "./engines/index.js";
export { appendEvent, isToken, newId, readEvents, timestamp, type ReadResult } from "./eventlog.js";
export { type HookResult, handleHook, recordEvents } from "./hookrunner.js";
export { type HookInput, askBeforeTool, eventKind, lastTranscriptUsage, parseHookPayload, showNote } from "./hooks.js";
export {
  DEFAULT_HOLDOUT_RATE,
  type LoadedLock,
  applyThresholds,
  builtInLock,
  defaultLock,
  lockHash,
  lockMismatch,
  readLock,
} from "./lock.js";
export { type Evaluation, type EvaluateInput, evaluate, sessionToken } from "./pipeline.js";
export { type DecisionQuestion, LABEL_SUGGESTION, QUESTIONS, labelsOf, questionHash, sha256 } from "./questions.js";
export { type Interval, type Receipt, RECEIPT_RULES, bootstrapSaving, buildReceipt, requestTokens } from "./receipt.js";
export { REDACTED, redact } from "./redact.js";
export {
  type FreshStartSignal,
  type Observation,
  SIGNAL_RULES,
  type SignalName,
  type StuckSignal,
  errorFingerprint,
  freshStartSignals,
  promptOverlap,
  stuckSignals,
} from "./signals.js";
export { type State, buildState } from "./state.js";
export { main } from "./cli.js";
