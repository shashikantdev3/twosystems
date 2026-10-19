// System 1 through OpenRouter's Decisions API (TypeSafe Jev, Microsoft Decision-1).
// Request and response shapes were checked against live calls on 15 Oct 2026
// in the author's decision-models-lab project.
// Part of twosystems, created by Shashikant.
import type { Engine as EngineInfo } from "../model.js";
import type { DecisionQuestion } from "../questions.js";
import { labelsOf } from "../questions.js";
import { type DecisionEngine, type EngineAnswer, EngineError, type FetchLike, type FetchResponseLike, platformFetch, normalize } from "./types.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
/** Default model: the cheaper of the two at the time of writing, and the one with the shorter context. */
export const DEFAULT_OPENROUTER_MODEL = "microsoft/microsoft-decision-1-20261009";

export interface OpenRouterOptions {
  apiKey: string | undefined;
  model?: string;
  url?: string;
  fetch?: FetchLike;
}

/** The JSON body sent to the decisions endpoint. */
export function decisionsBody(model: string, question: DecisionQuestion, state: readonly string[]) {
  return {
    model,
    state: [...state],
    questions: {
      [question.name]: { type: question.type, instructions: question.instructions, criteria: question.criteria },
    },
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read the answer to one question from a decisions response. Throws EngineError("bad_response"). */
export function parseDecisionsResponse(body: unknown, question: DecisionQuestion): EngineAnswer {
  const labels = labelsOf(question);
  const root = body as { model?: unknown; answers?: Record<string, unknown>; usage?: { cost?: unknown } } | null;
  const answer = root?.answers?.[question.name] as
    | { choice?: unknown; probabilities?: Record<string, unknown>; noul?: unknown }
    | undefined;
  if (answer === undefined || answer === null || typeof answer !== "object") {
    throw new EngineError("bad_response", `The response has no answer for "${question.name}".`);
  }
  const weights: Record<string, number> = {};
  if (answer.probabilities && typeof answer.probabilities === "object") {
    for (const label of labels) weights[label] = asNumber(answer.probabilities[label]) ?? 0;
  } else if (typeof answer.choice === "string" && labels.includes(answer.choice)) {
    weights[answer.choice] = 1;
  }
  if (Object.values(weights).every((w) => w <= 0)) {
    throw new EngineError("bad_response", `The answer for "${question.name}" has no usable probabilities.`);
  }
  const result: EngineAnswer = { probabilities: normalize(weights, labels) };
  if (typeof root?.model === "string") result.modelVersion = root.model;
  const cost = asNumber(root?.usage?.cost);
  if (cost !== undefined && cost >= 0) result.costUsd = cost;
  return result;
}

export class OpenRouterEngine implements DecisionEngine {
  readonly info: EngineInfo;
  readonly remote = true;
  private readonly options: OpenRouterOptions;

  constructor(options: OpenRouterOptions) {
    this.options = options;
    this.info = { kind: "openrouter", model: options.model ?? DEFAULT_OPENROUTER_MODEL };
  }

  async decide(request: {
    question: DecisionQuestion;
    state: readonly string[];
    signal: AbortSignal;
  }): Promise<EngineAnswer> {
    const key = this.options.apiKey;
    if (!key) throw new EngineError("no_key", "No OpenRouter key. Set OPENROUTER_API_KEY.");
    const doFetch = this.options.fetch ?? platformFetch();
    if (doFetch === undefined) throw new EngineError("network", "No way to make web requests here.");
    let response: FetchResponseLike;
    try {
      response = await doFetch(this.options.url ?? OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/shashikantdev3/twosystems",
          "X-Title": "twosystems",
        },
        body: JSON.stringify(decisionsBody(this.info.model ?? DEFAULT_OPENROUTER_MODEL, request.question, request.state)),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw new EngineError("timeout", "The decision model did not answer in time.");
      throw new EngineError("network", `Could not reach OpenRouter: ${(error as Error).message}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (request.signal.aborted) throw new EngineError("timeout", "The decision model did not answer in time.");
      throw new EngineError("network", "The connection to OpenRouter dropped.");
    }
    if (!response.ok) {
      throw new EngineError("http_error", `OpenRouter answered with HTTP ${response.status}.`, response.status);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new EngineError("bad_response", "OpenRouter returned something that is not JSON.");
    }
    return parseDecisionsResponse(body, request.question);
  }
}
