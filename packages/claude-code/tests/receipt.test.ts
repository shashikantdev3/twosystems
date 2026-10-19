// The receipt: exact usage records, the line under an answer, and /twosystems.
// Part of twosystems, created by Shashikant.
import { expect, test } from "claude-code/testing";
import { BAND_PROPS, HOME, LOG_DIR, start, turn, world } from "./world.js";

const OPTIONS = { options: { engine: "rules", holdout: 0 } };
const FAILING = "FAIL src/cart.test.ts\nAssertionError: expected 2 to equal 3";
const PRESENTATION = { isFullscreen: false, columns: 100 };

test("every main-loop request is recorded as exact usage in the session's own file", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  w.usage = { input: 1_500, cacheRead: 40_000 };
  await turn($, w, "add a dark mode toggle to settings");
  // Checked first, so a failure shows where the log landed.
  expect([...w.files.keys()]).toEqual([`${LOG_DIR}/claude-code-7f9c2a1e-0d3b-4c55-9a77-1b2c3d4e5f60.jsonl`]);
  const usage = w.events().filter((e) => e["type"] === "usage");
  expect(usage.length).toBe(1);
  expect(usage[0]?.["usage"]).toEqual({
    source: "exact",
    model: "claude-opus-5-5",
    input_tokens: 1_500,
    output_tokens: 200,
    cache_read_tokens: 40_000,
    cache_write_tokens: 0,
    context_tokens: 41_500,
  });
});

test("a turn where twosystems asked gets a line under the answer", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await $.turn.start({ text: "make the cart tests pass", turnId: "t1" });
  w.toolAnswer = { isError: true, text: FAILING };
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: "Bash", command: "npm test -- cart" });
  await $.tool.check({ tool: "Bash", input: { command: "npm test -- cart" }, tool_use_id: "toolu_4" });
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: "npm test -- cart" } });
  await $.tool.call({ tool: "Bash", command: "npm test -- cart", tool_use_id: "toolu_4" } as never);
  const done = await $.turn.complete({ answer: "Still failing.", durationMs: 9_000, isAborted: false, turnId: "t1", reason: "answer" });
  expect(done.text).toContain("twosystems: asked before a step (1 check, $0.00000)");
  expect(done.text).toContain("This session: 1 check");
  expect(w.statuses.at(-1)).toBe("twosystems: 1 check, $0.00000");
});

test("a quiet turn keeps its answer as it was", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  const done = await turn($, w, "rename the helper");
  expect(done.text).toBe("done");
});

test("the receipt line can be switched off", { options: { engine: "rules", holdout: 0, receipt_line: false } }, async ($, on) => {
  const w = world(on);
  await start($);
  await $.turn.start({ text: "make the cart tests pass", turnId: "t1" });
  w.toolAnswer = { isError: true, text: FAILING };
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: "Bash", command: "npm test -- cart" });
  await $.tool.check({ tool: "Bash", input: { command: "npm test -- cart" }, tool_use_id: "toolu_4" });
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: "npm test -- cart" } });
  await $.tool.call({ tool: "Bash", command: "npm test -- cart", tool_use_id: "toolu_4" } as never);
  const done = await $.turn.complete({ answer: "Still failing.", durationMs: 9_000, isAborted: false, turnId: "t1", reason: "answer" });
  expect(done.text).toBe("Still failing.");
});

test("after compacting, the next answer says how much smaller each request is", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  w.usage = { input: 2_000, cacheRead: 148_000 };
  await turn($, w, "fix the login bug in the auth module");
  await w.clock.advance(3_600_000 + 30_000);
  const ui = await $.ui.mount({ plugin: "twosystems", surface: "terminal", component: "AbovePrompt", props: BAND_PROPS });
  await ui.press({ key: "compact" });
  await w.clock.settle();
  w.usage = { input: 2_000, cacheRead: 10_000 };
  const done = await turn($, w, "now the logout bug");
  expect(done.text).toContain("twosystems: after compacting, each request sends about 12k tokens instead of 150k");
  const next = await turn($, w, "and the session timeout");
  expect(next.text).toBe("done");
});

test("/twosystems shows the settings, this session and the receipt", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  w.files.set(
    `${HOME}/.twosystems/events.jsonl`,
    `${JSON.stringify({ v: 1, id: "3b241101-e2bb-4255-8caf-4136c566a962", ts: "2026-10-19T09:00:00.000Z", type: "usage", agent: "copilot", session: "s1", usage: { source: "estimate", context_tokens: 1000 } })}\nnot json\n`,
  );
  w.usage = { input: 1_500, cacheRead: 40_000 };
  await turn($, w, "add a dark mode toggle to settings");
  const out = await $.command.run({ command: "twosystems", args: "receipt 7", origin: { kind: "composer" }, presentation: PRESENTATION });
  const text = out.text ?? "";
  expect(text).toContain("Engine:            rules (stays on this machine)");
  expect(text).toContain("twosystems receipt (last 7 days)");
  expect(text).toContain("Sessions watched:        2");
  expect(text).toContain("Skipped 1 unreadable line(s)");
});

test("hooks for the twosystems command in settings bring a warning", OPTIONS, async ($, on) => {
  const w = world(on, {
    settings: { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "twosystems hook --agent claude-code" }] }] } },
  });
  await start($);
  expect(w.toasts[0] ?? "").toContain("also run `twosystems hook`");
  const out = await $.command.run({ command: "twosystems", args: "", origin: { kind: "composer" }, presentation: PRESENTATION });
  expect(out.text ?? "").toContain("Note: your settings also run `twosystems hook`");
});

test("an OpenRouter key from the environment chooses the decision model, sent through Claude Code", { options: { holdout: 0 } }, async ($, on) => {
  const w = world(on, { env: { OPENROUTER_API_KEY: "sk-or-test" } });
  const requests: Array<{ url: string; body: string; auth: string }> = [];
  on("http.fetch", ($, e) => {
    requests.push({ url: e.url, body: e.init?.body ?? "", auth: e.init?.headers?.["Authorization"] ?? "" });
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          model: "microsoft/microsoft-decision-1-20261009",
          answers: { stuck: { type: "choice", choice: "stuck", probabilities: { progressing: 0.03, stuck: 0.97 }, confidence: 0.97 } },
          usage: { input_tokens: 400, output_tokens: 0, cost: 0.00002 },
        }),
      },
    };
  });
  await start($);
  w.toolAnswer = { isError: true, text: FAILING };
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: "Bash", command: "npm test -- cart" });
  const verdict = await $.tool.check({ tool: "Bash", input: { command: "npm test -- cart" }, tool_use_id: "toolu_4" });
  expect(verdict.decision).toBe("ask");
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: "npm test -- cart" } });
  await $.tool.call({ tool: "Bash", command: "npm test -- cart", tool_use_id: "toolu_4" } as never);
  expect(requests.length).toBe(1);
  expect(requests[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
  expect(requests[0]?.auth).toBe("Bearer sk-or-test");
  expect(requests[0]?.body ?? "").not.toContain("sk-or-test");
  await w.clock.settle();
  const decision = w.events().find((e) => e["type"] === "decision")?.["decision"] as Record<string, unknown>;
  expect(decision["engine"]).toEqual({
    kind: "openrouter",
    model: "microsoft/microsoft-decision-1-20261009",
    model_version: "microsoft/microsoft-decision-1-20261009",
  });
  expect(decision["cost_usd"]).toBe(0.00002);
});

test("a decision model that does not answer leaves the step alone", { options: { engine: "openrouter", openrouter_key: "sk-or-test", holdout: 0, timeout_ms: 500 } }, async ($, on) => {
  const w = world(on);
  on("http.fetch", async () => {
    await w.clock.sleep(10_000);
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  await start($);
  w.toolAnswer = { isError: true, text: FAILING };
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: "Bash", command: "npm test -- cart" });
  const pending = $.tool.check({ tool: "Bash", input: { command: "npm test -- cart" }, tool_use_id: "toolu_4" });
  await w.clock.advance(600);
  const verdict = await pending;
  expect(verdict.decision).toBe("allow");
  await w.clock.settle();
  const decision = w.events().find((e) => e["type"] === "decision")?.["decision"] as Record<string, unknown>;
  expect(decision["band"]).toBe("not_evaluated");
  expect(decision["reason"]).toBe("timeout");
});

test("a prompt held before a turn shows up under that turn's answer", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  w.usage = { input: 2_000, cacheRead: 98_000 };
  await turn($, w, "fix the login bug in the auth module");
  await $.prompt.submit({ text: "write marketing copy for the pricing page hero banner", wait: false, origin: { kind: "composer" } });
  const ui = await $.ui.mount({ plugin: "twosystems", surface: "terminal", component: "AbovePrompt", props: BAND_PROPS });
  await ui.press({ key: "send" });
  const done = await turn($, w, "write marketing copy for the pricing page hero banner");
  expect(done.text).toContain("suggested a fresh start");
});
