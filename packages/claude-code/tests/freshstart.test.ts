// The fresh-start check: the band above the prompt (a pane where no band is
// drawn), its buttons, the held prompt, and what each choice records.
// Part of twosystems, created by Shashikant.
import { type Engine, expect, test } from "claude-code/testing";
import { BAND_PROPS, type World, actions, decisions, start, turn, world } from "./world.js";

const OPTIONS = { options: { engine: "rules", holdout: 0 } };
const HOUR = 3_600_000;
const SESSION = "7f9c2a1e-0d3b-4c55-9a77-1b2c3d4e5f60";
const NEW_TASK = "write marketing copy for the pricing page hero banner";

async function largeAndIdle($: Engine, w: World): Promise<void> {
  w.usage = { input: 2_000, cacheRead: 148_000 };
  await turn($, w, "fix the login bug in the auth module");
  await w.clock.advance(HOUR + 30_000);
}

async function holdNewTask($: Engine, w: World): Promise<{ drop?: string }> {
  w.usage = { input: 2_000, cacheRead: 98_000 };
  await turn($, w, "fix the login bug in the auth module");
  return $.prompt.submit({ text: NEW_TASK, wait: false, origin: { kind: "composer" } });
}

async function band($: Engine) {
  return $.ui.mount({ plugin: "twosystems", surface: "terminal", component: "AbovePrompt", props: BAND_PROPS });
}

test("after an idle hour with a large conversation, the band suggests compacting", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await largeAndIdle($, w);
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ plugin: "twosystems", surface, component: "AbovePrompt", props: BAND_PROPS });
    expect((await ui.find({ type: "Text", text: /prompt cache has probably expired/i }))?.text ?? "").toContain("150k tokens");
    for (const key of ["compact", "clear", "keep"]) expect(await ui.find({ key })).toBeDefined();
    await ui.unmount();
  }
  const ui = await band($);
  await ui.press({ key: "compact" });
  await w.clock.settle();
  expect(w.compacts).toBe(1);
  expect(actions(w)).toEqual(["compact"]);
  const shown = decisions(w).filter((d) => d["band"] === "act");
  expect(shown.length).toBe(1);
  expect(shown[0]?.["suggestion"]).toBe("compact");
  expect(shown[0]?.["reason"]).toBe(undefined);
  // The compaction's own request is recorded as cost, not as a context size.
  const compaction = w.events().filter((e) => e["type"] === "usage").at(-1)?.["usage"] as Record<string, unknown>;
  expect(compaction["input_tokens"]).toBe(150_000);
  expect(compaction["context_tokens"]).toBe(undefined);
});

test("Keep going takes the band down and records the choice", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await largeAndIdle($, w);
  await (await band($)).press({ key: "keep" });
  await w.clock.settle();
  expect(actions(w)).toEqual(["keep_going"]);
  await $.prompt.submit({ text: "and also the logout bug", wait: false, origin: { kind: "composer" } });
  await w.clock.settle();
  expect(actions(w)).toEqual(["keep_going"]);
});

test("a prompt typed while the band shows goes through and counts as ignored", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await largeAndIdle($, w);
  const sent = await $.prompt.submit({ text: "and also the logout bug", wait: false, origin: { kind: "composer" } });
  expect(sent.drop).toBe(undefined);
  await w.clock.settle();
  expect(actions(w)).toEqual(["ignored"]);
});

test("a prompt sent from the Desktop app or VS Code while the band shows takes it down and counts as ignored", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await largeAndIdle($, w);
  const sent = await $.prompt.submit({ text: "and also the logout bug", wait: false, origin: { kind: "sdk" } });
  expect(sent.drop).toBe(undefined);
  await w.clock.settle();
  expect(actions(w)).toEqual(["ignored"]);
});

test("a typed /clear soon after a suggestion counts as taking it", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await largeAndIdle($, w);
  await $.session.end({ reason: "clear", sessionId: SESSION, resume: { kind: "none" } } as never);
  await w.clock.settle();
  expect(actions(w)).toEqual(["clear"]);
});

test("in VS Code, where no band is drawn, the suggestion opens in a pane", OPTIONS, async ($, on) => {
  const w = world(on);
  w.surfaces = ["vscode"];
  await start($);
  await largeAndIdle($, w);
  expect(w.opened).toEqual(["twosystems"]);
  const pane = await $.ui.mount({
    plugin: "twosystems",
    surface: "vscode",
    component: "Pane",
    requestId: "twosystems",
    props: { title: "twosystems", isFocused: false, bodyColumns: 80, placement: "dock", scroll: { offset: 0, bodyRows: 20 }, view: {} },
  });
  expect((await pane.find({ type: "Text", text: /prompt cache/ }))?.text ?? "").toContain("150k");
  await pane.press({ key: "keep" });
  await w.clock.settle();
  expect(actions(w)).toEqual(["keep_going"]);
  expect(w.closed).toContain("twosystems");
});

test("a pane that cannot be placed is not counted as shown", OPTIONS, async ($, on) => {
  const w = world(on);
  w.surfaces = ["vscode"];
  w.panePlaced = false;
  await start($);
  await largeAndIdle($, w);
  const act = decisions(w).filter((d) => d["band"] === "act");
  expect(act.length).toBe(1);
  expect(act[0]?.["reason"]).toBe("not_shown");
  // It is closed again rather than left waiting undrawn.
  expect(w.closed).toContain("twosystems");
});

test("a new task in a large conversation is held; Send as is sends it as the user's own words", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  const held = await holdNewTask($, w);
  expect(held.drop ?? "").toContain("holding this prompt");
  expect(w.submitted).toEqual([]);
  const ui = await band($);
  expect((await ui.find({ type: "Text", text: /Waiting/ }))?.text ?? "").toContain("marketing copy");
  expect((await ui.find({ key: "clear" }))?.text ?? "").toContain("Clear, then send");
  await ui.press({ key: "send" });
  await w.clock.settle();
  expect(w.submitted).toEqual([NEW_TASK]);
  expect(w.origins[0]?.["asUser"]).toBe(true);
  expect(actions(w)).toEqual(["continue"]);
});

test("Clear, then send clears through Claude Code's /clear and then sends the held prompt", OPTIONS, async ($, on) => {
  const w = world(on);
  w.onCommand = async (name) => {
    if (name === "clear") await $.session.end({ reason: "clear", sessionId: SESSION, resume: { kind: "none" } } as never);
  };
  await start($);
  await holdNewTask($, w);
  await (await band($)).press({ key: "clear" });
  await w.clock.settle();
  expect(w.commands).toEqual(["clear"]);
  expect(w.submitted).toEqual([NEW_TASK]);
  expect(actions(w)).toEqual(["clear"]);
});

test("Compact, then send compacts and then sends; a skipped compaction puts the prompt back", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await holdNewTask($, w);
  await (await band($)).press({ key: "compact" });
  await w.clock.settle();
  expect(w.compacts).toBe(1);
  expect(w.submitted).toEqual([NEW_TASK]);
  expect(actions(w)).toEqual(["compact"]);
});

test("a compaction that does not run puts the held prompt back in the box", OPTIONS, async ($, on) => {
  const w = world(on);
  w.compactAnswer = "skip";
  await start($);
  await holdNewTask($, w);
  await (await band($)).press({ key: "compact" });
  await w.clock.settle();
  expect(w.submitted).toEqual([]);
  expect(w.filled).toEqual([NEW_TASK]);
});

test("Edit puts the held prompt back in the box", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await holdNewTask($, w);
  await (await band($)).press({ key: "edit" });
  await w.clock.settle();
  expect(w.filled).toEqual([NEW_TASK]);
  expect(actions(w)).toEqual(["dismissed"]);
});

test("a held prompt is never lost: a typed /clear, /compact or new prompt puts it back", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await holdNewTask($, w);
  await $.session.end({ reason: "clear", sessionId: SESSION, resume: { kind: "none" } } as never);
  await w.clock.advance(1000);
  expect(w.filled).toEqual([NEW_TASK]);
  expect(actions(w)).toEqual(["clear"]);

  w.filled.length = 0;
  w.draft = "";
  w.usage = { input: 2_000, cacheRead: 98_000 };
  await turn($, w, "fix the login bug in the auth module");
  await $.prompt.submit({ text: NEW_TASK, wait: false, origin: { kind: "composer" } });
  await $.session.compact({ trigger: "manual", messages: [{ role: "user", text: "earlier work", toolUses: [] }] } as never);
  await w.clock.advance(1000);
  expect(w.filled).toEqual([NEW_TASK]);

  w.filled.length = 0;
  w.draft = "";
  await turn($, w, "fix the login bug in the auth module");
  await $.prompt.submit({ text: NEW_TASK, wait: false, origin: { kind: "composer" } });
  const other = await $.prompt.submit({ text: "actually, first rerun the auth tests", wait: false, origin: { kind: "composer" } });
  expect(other.drop).toBe(undefined);
  await w.clock.advance(1000);
  expect(w.filled).toEqual([NEW_TASK]);
});

test("Edit keeps what the user typed since, and adds the held prompt after it", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await holdNewTask($, w);
  w.draft = "also check the footer";
  await (await band($)).press({ key: "edit" });
  await w.clock.settle();
  expect(w.draft).toBe(`also check the footer\n${NEW_TASK}`);
});

test("when the prompt box cannot take a held prompt back, it keeps waiting whole, and a press is not a second answer", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await holdNewTask($, w);
  w.fillWorks = false;
  await (await band($)).press({ key: "edit" });
  await w.clock.settle();
  expect(actions(w)).toEqual(["dismissed"]);
  const ui = await band($);
  expect((await ui.find({ type: "Text", text: /still waiting/ }))?.text ?? "").toContain("could not put your held prompt back");
  // The suggestion was already answered, so only Send as is and Edit are offered.
  expect(await ui.find({ key: "clear" })).toBe(undefined);
  expect(await ui.find({ key: "compact" })).toBe(undefined);
  await ui.press({ key: "send" });
  await w.clock.settle();
  expect(w.submitted).toEqual([NEW_TASK]);
  expect(actions(w)).toEqual(["dismissed"]);
});

test("a /resume puts a held prompt back in the box", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await holdNewTask($, w);
  await $.session.end({ reason: "resume", sessionId: SESSION, resume: { kind: "none" } } as never);
  await w.clock.advance(1000);
  expect(w.filled).toEqual([NEW_TASK]);
  expect(actions(w)).toEqual([]);
});

test("an idle check never replaces a held prompt", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await holdNewTask($, w);
  await w.clock.advance(HOUR + 60_000);
  const ui = await band($);
  expect((await ui.find({ type: "Text", text: /Waiting/ }))?.text ?? "").toContain("marketing copy");
});

test("automatic compaction is recorded as cost but never as a choice", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  await largeAndIdle($, w);
  await $.session.compact({ trigger: "auto", messages: [{ role: "user", text: "earlier work", toolUses: [] }] } as never);
  await w.clock.settle();
  expect(actions(w)).toEqual([]);
  expect(w.events().filter((e) => e["type"] === "usage").length).toBe(2);
});

test("prompts on the same task, in a small chat, with @ mentions, or as commands are never held", OPTIONS, async ($, on) => {
  const w = world(on);
  await start($);
  w.usage = { input: 2_000, cacheRead: 98_000 };
  await turn($, w, "fix the login bug in the auth module");
  const same = await $.prompt.submit({ text: "the login bug also hits the auth module tests", wait: false, origin: { kind: "composer" } });
  expect(same.drop).toBe(undefined);
  const mention = await $.prompt.submit({ text: "write marketing copy for @docs/pricing.md hero banner", wait: false, origin: { kind: "composer" } });
  expect(mention.drop).toBe(undefined);
  w.usage = { input: 2_000, cacheRead: 5_000 };
  await turn($, w, "fix the login bug in the auth module");
  const small = await $.prompt.submit({ text: NEW_TASK, wait: false, origin: { kind: "composer" } });
  expect(small.drop).toBe(undefined);
});

test("holding prompts can be switched off", { options: { engine: "rules", holdout: 0, hold_new_task_prompts: false } }, async ($, on) => {
  const w = world(on);
  await start($);
  const sent = await holdNewTask($, w);
  expect(sent.drop).toBe(undefined);
});

test("a held-out suggestion is recorded as held out and nothing is shown", { options: { engine: "rules", holdout: 0.5 } }, async ($, on) => {
  const w = world(on);
  await start($);
  // Hold-out is random; try until one moment is held out, then check it showed nothing.
  for (let i = 0; i < 40; i++) {
    const sent = await holdNewTask($, w);
    const last = decisions(w).at(-1);
    if (last?.["holdout"] === true) {
      expect(sent.drop).toBe(undefined);
      expect(last["reason"]).toBe("holdout");
      return;
    }
    if (sent.drop !== undefined) await (await band($)).press({ key: "send" });
  }
  throw new Error("no held-out moment in 40 tries");
});
