// The stuck check: repeated failures lead to Claude Code's own dialog asking
// before the next step, only where that dialog is shown, and only answers the
// user gave are recorded. Part of twosystems, created by Shashikant.
import { type Engine, expect, test } from "claude-code/testing";
import { type World, actions, decisions, start, world } from "./world.js";

const FAILING = "FAIL src/cart.test.ts\nAssertionError: expected 2 to equal 3\n    at src/cart.test.ts:14:5";
const REFUSED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
const RULES = { options: { engine: "rules", holdout: 0 } };
const COMMAND = "npm test -- cart";

async function failThreeTimes($: Engine, w: World, agentId?: string): Promise<void> {
  w.toolAnswer = { isError: true, text: FAILING };
  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: "Bash", command: COMMAND, ...(agentId ? { agentId } : {}) } as never);
    await w.clock.advance(1000);
  }
}

test("repeated failures make Claude Code ask; a Yes is recorded once the dialog showed", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w);
  const verdict = await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
  expect(verdict.decision).toBe("ask");
  expect(verdict.reason ?? "").toContain("may be stuck");
  expect(verdict.reason ?? "").toContain("the same command keeps failing");
  await w.clock.settle();
  // The decision waits until the question is settled.
  expect(decisions(w).length).toBe(0);

  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: COMMAND }, permission_mode: "default" });
  w.toolAnswer = { isError: false, text: "ok" };
  await $.tool.call({ tool: "Bash", command: COMMAND, tool_use_id: "toolu_4" } as never);
  await w.clock.settle();
  const [decision] = decisions(w);
  expect(decision?.["name"]).toBe("stuck");
  expect(decision?.["band"]).toBe("act");
  expect(decision?.["suggestion"]).toBe("pause");
  expect(decision?.["reason"]).toBe(undefined);
  expect(actions(w)).toEqual(["keep_going"]);
  const record = w.events().find((e) => e["type"] === "decision");
  expect(record?.["agent"]).toBe("claude-code");
  expect(record?.["adapter_version"]).toBe("0.1.0-alpha.2");
  expect(record?.["agent_version"]).toBe("2.1.303");

  // The next steps are not questioned again on the same evidence.
  const again = await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_5" });
  expect(again.decision).toBe("allow");
});

test("a No in the dialog is recorded as stop", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w);
  await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: COMMAND } });
  w.toolAnswer = { isError: true, text: REFUSED };
  await $.tool.call({ tool: "Bash", command: COMMAND, tool_use_id: "toolu_4" } as never);
  await w.clock.settle();
  expect(actions(w)).toEqual(["stop"]);
});

test("an ask that never reached a dialog is recorded as not shown, with no answer", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w);
  await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
  await $.tool.call({ tool: "Bash", command: COMMAND, tool_use_id: "toolu_4" } as never);
  await w.clock.settle();
  expect(decisions(w)[0]?.["reason"]).toBe("not_shown");
  expect(actions(w)).toEqual([]);
});

test("a permission request answered by a hook beneath showed no dialog: not shown, and no answer recorded", RULES, async ($, on) => {
  const w = world(on);
  w.permissionAnswer = { decision: { behavior: "allow" } };
  await start($);
  await failThreeTimes($, w);
  await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: COMMAND }, permission_mode: "default" });
  await $.tool.call({ tool: "Bash", command: COMMAND, tool_use_id: "toolu_4" } as never);
  await w.clock.settle();
  expect(decisions(w)[0]?.["reason"]).toBe("not_shown");
  expect(actions(w)).toEqual([]);
});

test("a dialog for another call of the same tool does not count as the question shown", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w);
  await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
  // A parallel call that Claude Code's own rules asked about.
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  await $.tool.call({ tool: "Bash", command: COMMAND, tool_use_id: "toolu_4" } as never);
  await w.clock.settle();
  expect(decisions(w)[0]?.["reason"]).toBe("not_shown");
  expect(actions(w)).toEqual([]);
});

test("a turn interrupted at the question records that the user stopped", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w);
  await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: COMMAND } });
  await $.turn.complete({ answer: "", durationMs: 1000, isAborted: true, turnId: "turn-1", reason: "aborted" });
  await w.clock.settle();
  expect(actions(w)).toEqual(["stop"]);
});

for (const mode of ["dontAsk", "bypassPermissions", "auto"]) {
  test(`in ${mode} mode nothing is asked and nothing is recorded`, RULES, async ($, on) => {
    const w = world(on);
    await start($);
    await $.classic.UserPromptSubmit({ prompt: "make the cart tests pass", permission_mode: mode });
    await failThreeTimes($, w);
    const verdict = await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
    expect(verdict.decision).toBe("allow");
    await w.clock.settle();
    expect(decisions(w).length).toBe(0);
  });
}

test("with no permission mode reported (an organization that manages Claude Code), nothing is asked", RULES, async ($, on) => {
  const w = world(on);
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true });
  await failThreeTimes($, w);
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" })).decision).toBe("allow");
  // Once Claude Code reports a mode with a dialog, the check runs.
  await $.classic.PostToolUse({ tool_name: "Bash", tool_input: {}, tool_response: {}, tool_use_id: "toolu_x", permission_mode: "default" });
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_5" })).decision).toBe("ask");
});

test("a subagent with its own mode is judged by that mode", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await $.classic.PostToolUse({ tool_name: "Read", tool_input: {}, tool_response: {}, tool_use_id: "toolu_y", permission_mode: "bypassPermissions", agent_id: "agent-9" });
  await failThreeTimes($, w, "agent-9");
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_s", agentId: "agent-9" } as never)).decision).toBe("allow");
});

test("Claude Code's own questions are never asked about", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w);
  expect((await $.tool.check({ tool: "AskUserQuestion", input: {}, tool_use_id: "toolu_q" })).decision).toBe("allow");
});

test("calls that work and change files raise no question", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  for (let i = 0; i < 6; i++) {
    await $.tool.call({ tool: "Edit", file_path: `src/file${i}.ts`, old_string: "a", new_string: "b" });
    const verdict = await $.tool.check({ tool: "Edit", input: { file_path: `src/file${i}.ts` }, tool_use_id: `toolu_${i}` });
    expect(verdict.decision).toBe("allow");
  }
  await w.clock.settle();
  expect(decisions(w).length).toBe(0);
});

test("a deny stays a deny, and a query without a tool call is never questioned", RULES, async ($, on) => {
  const w = world(on);
  w.permission = (tool) => (tool === "Write" ? { decision: "deny", reason: "not allowed" } : { decision: "allow" });
  await start($);
  await failThreeTimes($, w);
  expect((await $.tool.check({ tool: "Write", input: { file_path: "x" }, tool_use_id: "toolu_9" })).decision).toBe("deny");
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND } })).decision).toBe("allow");
  await w.clock.settle();
  expect(decisions(w).length).toBe(0);
});

test("with nobody watching (claude -p) nothing is asked", RULES, async ($, on) => {
  const w = world(on);
  w.surfaces = [];
  await $.session.start({ cwd: "/work/shop", surface: null, isInteractive: false });
  await failThreeTimes($, w);
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" })).decision).toBe("allow");
});

test("a subagent's failures are its own; the main loop is not asked about them", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w, "agent-7");
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_m" })).decision).toBe("allow");
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_a", agentId: "agent-7" } as never)).decision).toBe("ask");
});

test("after a check, the next one waits five tool calls", RULES, async ($, on) => {
  const w = world(on);
  await start($);
  await failThreeTimes($, w);
  await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_4" });
  await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: { command: COMMAND } });
  await $.tool.call({ tool: "Bash", command: COMMAND, tool_use_id: "toolu_4" } as never);
  // Four calls since the check (including the one asked about): not yet due.
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(1000);
    await $.tool.call({ tool: "Bash", command: COMMAND });
    expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: `toolu_w${i}` })).decision).toBe("allow");
  }
  await w.clock.advance(1000);
  await $.tool.call({ tool: "Bash", command: COMMAND });
  expect((await $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_next" })).decision).toBe("ask");
});

test("two calls checked at once pay for one model call", { options: { engine: "openrouter", openrouter_key: "sk-or-test", holdout: 0 } }, async ($, on) => {
  const w = world(on);
  let requests = 0;
  on("http.fetch", async () => {
    requests += 1;
    await w.clock.sleep(200);
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ answers: { stuck: { type: "choice", choice: "stuck", probabilities: { progressing: 0.02, stuck: 0.98 } } }, usage: { cost: 0.00001 } }),
      },
    };
  });
  await start($);
  await failThreeTimes($, w);
  const both = Promise.all([
    $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_a" }),
    $.tool.check({ tool: "Bash", input: { command: COMMAND }, tool_use_id: "toolu_b" }),
  ]);
  await w.clock.advance(300);
  const verdicts = await both;
  expect(requests).toBe(1);
  expect(verdicts.map((v) => v.decision).sort()).toEqual(["allow", "ask"]);
});
