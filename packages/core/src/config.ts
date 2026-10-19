// Settings, read from environment variables. Nothing is stored in a config file
// yet; adapters pass their own settings in from the host (Claude Code settings,
// VS Code secret storage) in later sprints.
// Part of twosystems, created by Shashikant.
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineKind } from "./contracts.js";
import { DEFAULT_HOLDOUT_RATE } from "./lock.js";

export interface Config {
  /** Folder for the event log, session notes and decisions.lock. */
  home: string;
  eventsPath: string;
  /** Folder of per-session event files written by the Claude Code plugin. */
  eventsDir: string;
  lockPath: string;
  sessionsDir: string;
  engine: Exclude<EngineKind, "llm">;
  /** Model id for OpenRouter or Ollama. */
  model?: string;
  openRouterKey?: string;
  ollamaHost: string;
  /** Share of eligible moments where twosystems stays silent on purpose, from 0 to 0.5. */
  holdoutRate: number;
  /** How long to wait for the decision model before staying silent. */
  timeoutMs: number;
  /** How long the provider keeps the prompt cache, when set by the user. See cacheTtlFor. */
  cacheTtlSeconds?: number;
  /** Settings that were set but could not be used, with the reason. */
  warnings: string[];
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number, warnings: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    warnings.push(`${name} is not a number from ${min} to ${max}; using the default.`);
    return fallback;
  }
  return value;
}

/** Read settings from the environment. Unknown or bad values fall back to safe defaults with a warning. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];
  const home = env["TWOSYSTEMS_HOME"]?.trim() || join(homedir(), ".twosystems");
  const openRouterKey = env["OPENROUTER_API_KEY"]?.trim() || undefined;

  let engine: Config["engine"] = openRouterKey ? "openrouter" : "rules";
  const chosen = env["TWOSYSTEMS_ENGINE"]?.trim().toLowerCase();
  if (chosen) {
    if (chosen === "rules" || chosen === "openrouter" || chosen === "ollama") engine = chosen;
    else warnings.push(`TWOSYSTEMS_ENGINE is not rules, openrouter or ollama; using ${engine}.`);
  }

  const config: Config = {
    home,
    eventsPath: join(home, "events.jsonl"),
    eventsDir: join(home, "events.d"),
    lockPath: env["TWOSYSTEMS_LOCK"]?.trim() || join(home, "decisions.lock"),
    sessionsDir: join(home, "sessions"),
    engine,
    ollamaHost: env["OLLAMA_HOST"]?.trim() || "http://127.0.0.1:11434",
    holdoutRate: number(env, "TWOSYSTEMS_HOLDOUT", DEFAULT_HOLDOUT_RATE, 0, 0.5, warnings),
    // Hook files give the command 15 seconds in all, so the model gets at most 10.
    // A model's first call of the day can take close to 3 seconds, so the default allows 5.
    timeoutMs: number(env, "TWOSYSTEMS_TIMEOUT_MS", 5000, 100, 10_000, warnings),
    warnings,
  };
  const ttl = number(env, "TWOSYSTEMS_CACHE_TTL_S", -1, 30, 86_400, warnings);
  if (ttl > 0) config.cacheTtlSeconds = ttl;
  const model = env["TWOSYSTEMS_MODEL"]?.trim();
  if (model && /^[A-Za-z0-9._:/@+-]{1,128}$/.test(model)) config.model = model;
  else if (model) warnings.push("TWOSYSTEMS_MODEL may only use letters, digits and . _ : / @ + -; ignoring it.");
  if (openRouterKey) config.openRouterKey = openRouterKey;
  return config;
}

/**
 * Prompt cache lifetime to assume for an agent. Claude Code on a Claude plan
 * keeps the main conversation cached for an hour; API keys and most other
 * agents get five minutes. A user setting always wins.
 */
export function cacheTtlFor(config: Config, agent: string): number {
  if (config.cacheTtlSeconds !== undefined) return config.cacheTtlSeconds;
  return agent === "claude-code" ? 3600 : 300;
}
