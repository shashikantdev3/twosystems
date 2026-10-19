// System 1 on the user's own machine, through Ollama's decisions endpoint
// (POST /v1/systemone, Ollama 0.35 or newer) with a local decision model such
// as nimble, clef-flash or tev1. Nothing leaves the machine unless the host is
// remote or the model is an Ollama cloud model.
// Part of twosystems, created by Shashikant.
import type { Engine as EngineInfo } from "../contracts.js";
import type { DecisionQuestion } from "../questions.js";
import { parseDecisionsResponse } from "./openrouter.js";
import { type DecisionEngine, type EngineAnswer, EngineError } from "./types.js";

export interface OllamaOptions {
  model: string | undefined;
  host?: string;
  fetch?: typeof fetch;
}

/** True when the host is this machine. */
export function isLocalHost(host: string): boolean {
  try {
    const name = new URL(host).hostname.replace(/^\[|\]$/g, "");
    return name === "localhost" || name === "::1" || name.startsWith("127.");
  } catch {
    return false;
  }
}

export class OllamaEngine implements DecisionEngine {
  readonly info: EngineInfo;
  readonly remote: boolean;
  private readonly options: OllamaOptions;
  private readonly host: string;

  constructor(options: OllamaOptions) {
    this.options = options;
    this.host = (options.host ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.info = options.model ? { kind: "ollama", model: options.model } : { kind: "ollama" };
    this.remote = !isLocalHost(this.host) || (options.model ?? "").endsWith(":cloud");
  }

  async decide(request: { question: DecisionQuestion; state: readonly string[]; signal: AbortSignal }): Promise<EngineAnswer> {
    const model = this.options.model;
    if (!model) throw new EngineError("no_model", "No Ollama model chosen. Set TWOSYSTEMS_MODEL, for example nimble.");
    const { question } = request;
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.host}/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          // Ollama takes the state as one string or an object, not a list.
          state: request.state.join("\n"),
          questions: {
            [question.name]: { type: question.type, instructions: question.instructions, criteria: question.criteria },
          },
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw new EngineError("timeout", "The local model did not answer in time.");
      throw new EngineError("network", `Could not reach Ollama at ${this.host}: ${(error as Error).message}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (request.signal.aborted) throw new EngineError("timeout", "The local model did not answer in time.");
      throw new EngineError("network", "The connection to Ollama dropped.");
    }
    if (!response.ok) {
      throw new EngineError("http_error", `Ollama answered with HTTP ${response.status}.`, response.status);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new EngineError("bad_response", "Ollama returned something that is not JSON.");
    }
    return parseDecisionsResponse(body, question);
  }
}
