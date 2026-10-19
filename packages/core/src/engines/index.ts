// Pick the decision engine from the settings. Part of twosystems, created by Shashikant.
import type { Config } from "../config.js";
import { OllamaEngine } from "./ollama.js";
import { OpenRouterEngine } from "./openrouter.js";
import { RulesEngine } from "./rules.js";
import type { DecisionEngine } from "./types.js";

export function createEngine(config: Config, fetchImpl?: typeof fetch): DecisionEngine {
  if (config.engine === "openrouter") {
    return new OpenRouterEngine({
      apiKey: config.openRouterKey,
      ...(config.model ? { model: config.model } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }
  if (config.engine === "ollama") {
    return new OllamaEngine({ model: config.model, host: config.ollamaHost, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }
  return new RulesEngine();
}

export { OllamaEngine } from "./ollama.js";
export { OpenRouterEngine, DEFAULT_OPENROUTER_MODEL } from "./openrouter.js";
export { RulesEngine } from "./rules.js";
export { EngineError, type DecisionEngine, type EngineAnswer, type EngineFailure } from "./types.js";
