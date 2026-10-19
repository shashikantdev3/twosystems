// Tests for the decision engines, with real OpenRouter responses as fixtures.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterEngine,
  decisionsBody,
  parseDecisionsResponse,
} from "../src/engines/openrouter.js";
import { OllamaEngine, isLocalHost } from "../src/engines/ollama.js";
import { RulesEngine, freshStartProbabilities, stuckProbabilities } from "../src/engines/rules.js";
import { EngineError, normalize } from "../src/engines/types.js";
import { type DecisionQuestion, QUESTIONS } from "../src/questions.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8")) as {
    request: unknown;
    response: unknown;
  };

// The fixtures asked a "team" choice question; the parser must read it the same way as ours.
const TEAM: DecisionQuestion = {
  name: "team" as never,
  type: "choice",
  instructions: "Which team should own this?",
  criteria: { payments: "Checkout and billing", auth: "Login and access", infra: "Servers, network and outages" },
};

for (const file of ["openrouter.decision-1.2026-10-15.json", "openrouter.jev-1.14.2026-10-15.json"]) {
  test(`reads a real choice answer from ${file}`, () => {
    const answer = parseDecisionsResponse(fixture(file).response, TEAM);
    const total = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.deepEqual(Object.keys(answer.probabilities), ["payments", "auth", "infra"]);
    assert.ok((answer.probabilities["payments"] ?? 0) > 0.5);
    assert.match(answer.modelVersion ?? "", /^(microsoft|typesafe)\//);
    assert.ok((answer.costUsd ?? 0) > 0);
  });
}

test("the request body has the shape the API accepts", () => {
  const body = decisionsBody(DEFAULT_OPENROUTER_MODEL, QUESTIONS.stuck, ["line one"]);
  assert.deepEqual(Object.keys(body), ["model", "state", "questions"]);
  assert.deepEqual(Object.keys(body.questions), ["stuck"]);
  assert.deepEqual(body.questions.stuck, {
    type: "choice",
    instructions: QUESTIONS.stuck.instructions,
    criteria: QUESTIONS.stuck.criteria,
  });
});

test("a choice without probabilities counts as certain; garbage is a bad response", () => {
  const sure = parseDecisionsResponse({ answers: { team: { type: "choice", choice: "infra" } } }, TEAM);
  assert.deepEqual(sure.probabilities, { payments: 0, auth: 0, infra: 1 });
  for (const body of [null, {}, { answers: {} }, { answers: { team: { choice: "nobody" } } }, { answers: { team: 3 } }]) {
    assert.throws(() => parseDecisionsResponse(body, TEAM), (e: unknown) => e instanceof EngineError && e.reason === "bad_response");
  }
});

function fakeFetch(status: number, body: string, seen?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      if (init) seen.init = init;
    }
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("OpenRouter engine sends the key and model, and reads the answer", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const response = { model: "microsoft/microsoft-decision-1-20261009", answers: { stuck: { choice: "stuck", probabilities: { progressing: 0.2, stuck: 0.8 } } }, usage: { cost: 0.00001 } };
  const engine = new OpenRouterEngine({ apiKey: "test-key", fetch: fakeFetch(200, JSON.stringify(response), seen) });
  const answer = await engine.decide({ question: QUESTIONS.stuck, state: ["x"], signal: new AbortController().signal });
  assert.deepEqual(answer.probabilities, { progressing: 0.2, stuck: 0.8 });
  assert.equal(seen.url, "https://openrouter.ai/api/alpha/decisions");
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-key");
  assert.equal(JSON.parse(String(seen.init?.body)).model, DEFAULT_OPENROUTER_MODEL);
  assert.deepEqual(engine.info, { kind: "openrouter", model: DEFAULT_OPENROUTER_MODEL });
});

test("OpenRouter engine failures carry a reason code", async () => {
  const signal = new AbortController().signal;
  const reason = async (engine: OpenRouterEngine) =>
    engine.decide({ question: QUESTIONS.stuck, state: [], signal }).then(
      () => "none",
      (e: unknown) => (e instanceof EngineError ? e.reason : "other"),
    );
  assert.equal(await reason(new OpenRouterEngine({ apiKey: undefined })), "no_key");
  assert.equal(await reason(new OpenRouterEngine({ apiKey: "k", fetch: fakeFetch(401, "{}") })), "http_error");
  assert.equal(await reason(new OpenRouterEngine({ apiKey: "k", fetch: fakeFetch(200, "not json") })), "bad_response");
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal(await reason(new OpenRouterEngine({ apiKey: "k", fetch: offline })), "network");
});

test("the rules engine turns signals into probabilities without a model", async () => {
  assert.deepEqual(stuckProbabilities([]), { progressing: 1, stuck: 0 });
  assert.equal(stuckProbabilities(["repeated_error", "repeated_command"]).stuck, 0.875);
  assert.equal(freshStartProbabilities(["new_prompt_low_overlap", "large_context"]).clear, 0.8);
  assert.equal(freshStartProbabilities(["large_context", "cache_expired"]).compact, 0.8);
  const engine = new RulesEngine();
  const answer = await engine.decide({ question: QUESTIONS.fresh_start, signals: ["large_context"] });
  assert.deepEqual(answer.probabilities, { continue: 0.35, compact: 0.65, clear: 0 });
  assert.equal(engine.remote, false);
});

test("normalize keeps only the question's labels and handles all-zero weights", () => {
  assert.deepEqual(normalize({ a: 2, b: 2, zzz: 9 }, ["a", "b"]), { a: 0.5, b: 0.5 });
  assert.deepEqual(normalize({ a: 0, b: Number.NaN }, ["a", "b"]), { a: 0.5, b: 0.5 });
});

test("Ollama engine posts one state string to /v1/systemone and reads the answer", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const response = { model: "nimble", answers: { stuck: { type: "choice", choice: "stuck", probabilities: { progressing: 0.3, stuck: 0.7 }, confidence: 0.6 } }, usage: { input_tokens: 90, output_tokens: 1 } };
  const engine = new OllamaEngine({ model: "nimble", host: "http://127.0.0.1:11434/", fetch: fakeFetch(200, JSON.stringify(response), seen) });
  const answer = await engine.decide({ question: QUESTIONS.stuck, state: ["line one", "line two"], signal: new AbortController().signal });
  assert.equal(seen.url, "http://127.0.0.1:11434/v1/systemone");
  const body = JSON.parse(String(seen.init?.body)) as { model: string; state: unknown; questions: Record<string, unknown> };
  assert.equal(body.model, "nimble");
  assert.equal(body.state, "line one\nline two");
  assert.deepEqual(Object.keys(body.questions), ["stuck"]);
  assert.deepEqual(answer.probabilities, { progressing: 0.3, stuck: 0.7 });
  assert.equal(answer.costUsd, undefined);
  assert.equal(engine.remote, false);
  assert.deepEqual(engine.info, { kind: "ollama", model: "nimble" });
});

test("Ollama engine knows when the summary would leave the machine, and reports failures", async () => {
  assert.equal(isLocalHost("http://localhost:11434"), true);
  assert.equal(isLocalHost("http://[::1]:11434"), true);
  assert.equal(isLocalHost("http://192.168.1.20:11434"), false);
  assert.equal(isLocalHost("not a url"), false);
  assert.equal(new OllamaEngine({ model: "nimble", host: "http://gpu-box:11434" }).remote, true);
  assert.equal(new OllamaEngine({ model: "clef:cloud" }).remote, true);
  const signal = new AbortController().signal;
  const reason = async (engine: OllamaEngine) =>
    engine.decide({ question: QUESTIONS.stuck, state: [], signal }).then(
      () => "none",
      (e: unknown) => (e instanceof EngineError ? e.reason : "other"),
    );
  assert.equal(await reason(new OllamaEngine({ model: undefined })), "no_model");
  assert.equal(await reason(new OllamaEngine({ model: "nimble", fetch: fakeFetch(404, '{"error":"model not found"}') })), "http_error");
  assert.equal(await reason(new OllamaEngine({ model: "nimble", fetch: fakeFetch(200, "<html>") })), "bad_response");
});
