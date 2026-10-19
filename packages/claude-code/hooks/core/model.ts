// The shapes of the two shared files, the event log and decisions.lock, as
// plain TypeScript types with their size limits. No runtime dependencies, so
// every adapter can use them, the Claude Code plugin included. The JSON
// Schemas in /schemas are the source of truth; contracts.ts validates against them.
// Part of twosystems, created by Shashikant.
export type Agent = "claude-code" | "copilot" | "codex" | "cursor" | "windsurf" | "other";
export type DecisionName = "stuck" | "fresh_start";
export type EngineKind = "rules" | "openrouter" | "ollama" | "llm";
export type Band = "act" | "unsure" | "silent" | "not_evaluated";
export type Suggestion = "continue" | "compact" | "clear" | "pause";
export type UserActionKind =
  | "clear"
  | "compact"
  | "keep_going"
  | "stop"
  | "hint"
  | "continue"
  | "dismissed"
  | "ignored";

export interface Engine {
  kind: EngineKind;
  model?: string;
  model_version?: string;
}

export interface Usage {
  source: "exact" | "estimate";
  request_id?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  context_tokens?: number;
  cost_usd?: number;
  plan_percent_used?: number;
}

export interface Decision {
  name: DecisionName;
  engine: Engine;
  state_hash: string;
  signals?: string[];
  probabilities?: Record<string, number>;
  suggestion?: Suggestion;
  band: Band;
  holdout: boolean;
  lock_hash?: string;
  latency_ms?: number;
  cost_usd?: number;
  reason?: string;
}

export interface UserAction {
  decision_id: string;
  action: UserActionKind;
}

interface EventBase {
  v: 1;
  id: string;
  ts: string;
  agent: Agent;
  agent_version?: string;
  session: string;
  adapter_version?: string;
}

export type TwoSystemsEvent =
  | (EventBase & { type: "usage"; usage: Usage })
  | (EventBase & { type: "decision"; decision: Decision })
  | (EventBase & { type: "user_action"; user_action: UserAction });

export interface Thresholds {
  act: number;
  unsure: number;
}

export interface LockDecision {
  engine: Engine;
  question_hash: string;
  labels: string[];
  calibration: {
    method: "none" | "temperature" | "platt" | "isotonic";
    params?: Record<string, number | number[]>;
  };
  thresholds: Record<string, Thresholds>;
  target_false_alarm: number;
  fitted_on?: { n: number; false_alarm_upper: number; coverage?: number; confidence: number };
}

export interface DecisionsLock {
  lock_version: 1;
  created_at: string;
  created_by: string;
  holdout_rate: number;
  decisions: Partial<Record<DecisionName, LockDecision>>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Largest event record accepted, in UTF-8 bytes. Real records are under 2 KB. */
export const MAX_EVENT_BYTES = 16_384;
/** Largest decisions.lock accepted, in UTF-8 bytes. */
export const MAX_LOCK_BYTES = 1_048_576;
