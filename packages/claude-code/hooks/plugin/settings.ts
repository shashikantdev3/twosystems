// The plugin's settings, from the /config rows its manifest declares, and the
// decision engine they choose. Part of twosystems, created by Shashikant.
import {
  type DecisionEngine,
  type DecisionsLock,
  type FetchLike,
  type LoadedLock,
  OllamaEngine,
  OpenRouterEngine,
  RulesEngine,
  builtInLock,
  isToken,
  lockHash,
} from "../core/portable.js";

export type FalseAlarmBudget = "low" | "medium" | "high";

export interface Settings {
  engine: "rules" | "openrouter" | "ollama";
  openRouterKey?: string;
  model?: string;
  ollamaHost: string;
  holdoutRate: number;
  falseAlarmBudget: FalseAlarmBudget;
  cacheTtlSeconds: number;
  holdNewTaskPrompts: boolean;
  receiptLine: boolean;
  timeoutMs: number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/**
 * Read the settings. `options` are the plugin's /config values; `envKey` is
 * OPENROUTER_API_KEY from the environment, used when no key is set here.
 */
export function readSettings(options: Readonly<Record<string, unknown>>, envKey: string | undefined): Settings {
  const key = text(options["openrouter_key"]) ?? text(envKey);
  const chosen = text(options["engine"]) ?? "auto";
  const engine =
    chosen === "rules" || chosen === "openrouter" || chosen === "ollama" ? chosen : key !== undefined ? "openrouter" : "rules";
  const model = text(options["model"]);
  const budget = text(options["false_alarm_budget"]);
  const settings: Settings = {
    engine,
    ollamaHost: text(options["ollama_host"]) ?? "http://127.0.0.1:11434",
    holdoutRate: number(options["holdout"], 0.1, 0, 0.5),
    falseAlarmBudget: budget === "medium" || budget === "high" ? budget : "low",
    cacheTtlSeconds: text(options["cache_minutes"]) === "5" ? 300 : 3600,
    holdNewTaskPrompts: options["hold_new_task_prompts"] !== false,
    receiptLine: options["receipt_line"] !== false,
    timeoutMs: number(options["timeout_ms"], 5000, 500, 8000),
  };
  if (key !== undefined) settings.openRouterKey = key;
  if (model !== undefined && isToken(model)) settings.model = model;
  return settings;
}

/** The engine the settings choose. `fetch` is the host's, so requests go through Claude Code. */
export function makeEngine(settings: Settings, fetch: FetchLike): DecisionEngine {
  if (settings.engine === "openrouter") {
    return new OpenRouterEngine({ apiKey: settings.openRouterKey, fetch, ...(settings.model ? { model: settings.model } : {}) });
  }
  if (settings.engine === "ollama") return new OllamaEngine({ model: settings.model, host: settings.ollamaHost, fetch });
  return new RulesEngine();
}

/** How far each budget lowers the built-in thresholds. */
const SHIFT: Record<FalseAlarmBudget, number> = { low: 0, medium: 0.05, high: 0.1 };

/**
 * The built-in thresholds for this engine, lowered for a larger false-alarm
 * budget. Until calibration ships this is a plain shift, not a measured rate;
 * the lock's hash changes with it, so receipts can tell the settings apart.
 */
export function thresholdsFor(engine: DecisionEngine, budget: FalseAlarmBudget): LoadedLock {
  const base = builtInLock(engine.info);
  const shift = SHIFT[budget];
  if (shift === 0) return base;
  const lock: DecisionsLock = structuredClone(base.lock);
  lock.created_by = `twosystems built-in defaults, false-alarm level ${budget}, not fitted on data`;
  for (const decision of Object.values(lock.decisions)) {
    if (decision === undefined) continue;
    for (const limits of Object.values(decision.thresholds)) {
      limits.act = Math.max(0.5, Math.round((limits.act - shift) * 100) / 100);
      limits.unsure = Math.max(0.4, Math.min(limits.act, Math.round((limits.unsure - shift) * 100) / 100));
    }
  }
  return { lock, hash: lockHash(lock), source: "built-in" };
}
