// twosystems core, created by Shashikant.
// https://github.com/shashikantdev3/twosystems
import { readFileSync } from "node:fs";

/** Version of this package, read from its package.json. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

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
