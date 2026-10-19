// twosystems for Claude Code: the stuck check, the fresh-start check and the
// honest receipt, running inside Claude Code as a mod.
//
// - Stuck: before a tool call, rule signals are checked; when they fire (and
//   at most once every five calls per loop), a decision model or the rules
//   alone judge; when confident, and only in a permission mode where Claude
//   Code shows its dialog, Claude Code asks the user before the step.
// - Fresh start: when the conversation is large, the prompt cache has probably
//   expired, or a new prompt looks like a different task, a band above the
//   prompt (a pane where no band is drawn) offers Clear, Compact or Keep going.
//   Nothing is done without a press, and a held prompt is always put back or
//   kept waiting, never dropped.
// - Receipt: exact usage per request (compactions included), every decision
//   and every choice go to ~/.twosystems/events.d/, a line under the next
//   answer says what happened, and /twosystems shows the receipt.
//
// Any failure of twosystems itself leaves Claude Code as it would be without it.
// Part of twosystems, created by Shashikant.
import type { EngineInterface, Register } from "claude-code";
import type { TwosystemsBand } from "../types";
import {
  type DecisionName,
  type Evaluation,
  type FetchLike,
  type Observation,
  SIGNAL_RULES,
  type TwoSystemsEvent,
  type UserActionKind,
  buildReceipt,
  evaluate,
  exactUsageRecord,
  formatReceipt,
  freshStartSignals,
  money,
  toolCommand,
  toolFiles,
  userActionRecord,
} from "./core/portable.js";
import { EventLog, type LogFiles, homeFolder } from "./plugin/eventlog.js";
import { type Settings, makeEngine, readSettings, thresholdsFor } from "./plugin/settings.js";
import { type FollowUp, type PendingAsk, Tracker, askOutcome, stableJson } from "./plugin/tracker.js";
import { bandMessage, excerpt, receiptLine, statusText, stuckReason } from "./plugin/text.js";
import { VERSION } from "./plugin/version.js";

type Host = EngineInterface;
type Choice = "clear" | "compact" | "keep" | "send" | "edit";
/** Where a suggestion can appear: the band above the prompt, a pane, or nowhere. */
type Place = "band" | "pane" | "none";

const BAND = { plugin: "twosystems", key: "band" } as const;
const PANE = "twosystems";
const AGENT = "claude-code" as const;
const MANUAL_HOOKS_WARNING =
  "your settings also run `twosystems hook`. Remove those hooks: this plugin does the same job, and with both you may be asked twice.";
/** Permission modes in which an "ask" reaches the user as Claude Code's dialog. */
const ASKING_MODES = new Set(["default", "acceptEdits", "plan"]);
/** Tools that are themselves a question to the user; never ask before them. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
/** An @ mention, which a re-sent prompt would not expand, so such prompts are never held. */
const MENTION = /(^|\s)@\S/;

/** Claude Code's file operations, as the event log needs them. */
function hostFiles($: Host): LogFiles {
  return {
    read: async (path) => (await $.fs.read(path)) as string,
    write: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path),
    list: (path) => $.fs.list(path),
  };
}

/** Claude Code's web requests, as the decision engines need them. */
function hostFetch($: Host): FetchLike {
  return async (url, init) => {
    const response = await $.http.fetch(url, { method: init.method, headers: init.headers, body: init.body });
    return { ok: response.ok, status: response.status, text: async () => response.text };
  };
}

// The session's state lives in this module, so a reload of the plugin starts it afresh.
/** The plugin's /config values, as the last load received them. */
let options: Readonly<Record<string, unknown>> = {};
const tracker = new Tracker();
let settings: Settings = readSettings({}, undefined);
let log = new EventLog(null);
let home: string | null = null;
let agentVersion: string | undefined;
let running = false;
let idleTimer: { cancel: () => void } | null = null;
const warnings: string[] = [];
let started: Promise<void> | null = null;
/**
 * The latest permission mode Claude Code reported for each loop. Where an
 * organization manages Claude Code, these reports do not reach a plugin the
 * person installed; with no mode known, the stuck check stays silent rather
 * than guess, because an "ask" in a mode without a dialog could block a step.
 */
const modeByLoop = new Map<string, string>();

/** The permission mode a loop runs in: its own when reported, else the main loop's; undefined when none was reported. */
function modeOf(agentId: string | undefined): string | undefined {
  return modeByLoop.get(tracker.key(agentId)) ?? modeByLoop.get(tracker.key(undefined));
}

function noteMode(e: { permission_mode?: string; agent_id?: string }): void {
  if (typeof e.permission_mode !== "string") return;
  modeByLoop.set(tracker.key(e.agent_id), e.permission_mode);
  if (modeByLoop.size > 64) modeByLoop.delete(modeByLoop.keys().next().value as string);
}

/** Write a stuck decision once its question is settled, and the user's answer when they saw it. */
async function settleAsk($: Host, pending: PendingAsk, outcome: UserActionKind): Promise<void> {
  await record($, { signals: [], event: pending.event }, pending.shown);
  if (pending.shown) await recordAction($, pending.session, pending.decisionId, outcome);
}

/** Read settings and the environment once per load. Each piece falls back quietly. */
function ready($: Host): Promise<void> {
  started ??= (async () => {
    const envKey = await $.env.get("OPENROUTER_API_KEY").catch(() => undefined);
    settings = readSettings(options, envKey);
    home = homeFolder({
      twosystemsHome: await $.env.get("TWOSYSTEMS_HOME").catch(() => undefined),
      home: await $.env.get("HOME").catch(() => undefined),
      userProfile: await $.env.get("USERPROFILE").catch(() => undefined),
    });
    log = new EventLog(home);
    agentVersion = await $.session
      .version()
      .then((v) => v.version)
      .catch(() => undefined);
    await refreshWindow($);
    const merged = (await $.settings.read().catch(() => ({}))) as { hooks?: unknown };
    const hooks = JSON.stringify(merged.hooks ?? {});
    if (/twosystems(\.cmd|\.ps1|\.js)?["']?\s+hook\b/.test(hooks)) warnings.push(MANUAL_HOOKS_WARNING);
  })();
  return started;
}

async function refreshWindow($: Host): Promise<void> {
  const window = await $.session
    .usage()
    .then((u) => u.context.window)
    .catch(() => undefined);
  if (window !== undefined && window > 0) tracker.contextWindow = window;
}

async function sessionId($: Host): Promise<string> {
  return $.session.id().catch(() => "unknown-session");
}

/** True when someone can see this session: a terminal, the Desktop app, VS Code or a phone. */
async function hasPerson($: Host): Promise<boolean> {
  return (await surfaces($)).length > 0;
}

async function surfaces($: Host): Promise<readonly string[]> {
  return $.session.surfaces().catch((): readonly string[] => []);
}

/** The band draws on the terminal and the Desktop app; elsewhere a pane stands in. */
async function placeFor($: Host): Promise<Place> {
  const attached = await surfaces($);
  if (attached.includes("terminal") || attached.includes("desktop")) return "band";
  return attached.length > 0 ? "pane" : "none";
}

function source() {
  return { agent: AGENT, adapterVersion: VERSION, ...(agentVersion ? { agentVersion } : {}) };
}

function write($: Host, events: readonly TwoSystemsEvent[]): void {
  void log.append(hostFiles($), events);
}

async function recordAction($: Host, session: string, decisionId: string, action: UserActionKind): Promise<void> {
  const at = await $.clock.now();
  write($, [userActionRecord({ ...source(), session }, at, decisionId, action)]);
}

/** The usage of a compaction's own model request: a cost of taking the suggestion, not a context size. */
async function recordCompaction(
  $: Host,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined,
): Promise<void> {
  if (usage === undefined) return;
  const record = exactUsageRecord({ ...source(), session: await sessionId($) }, await $.clock.now(), {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  });
  delete record.usage.context_tokens;
  write($, [record]);
}

async function showStatus($: Host): Promise<void> {
  if (tracker.totals.checks === 0 || !(await hasPerson($))) return;
  $.ui.status(`twosystems: ${tracker.totals.checks} ${tracker.totals.checks === 1 ? "check" : "checks"}, ${money(tracker.totals.costUsd)}`);
}

/** Run one decision through the shared pipeline. The caller records it with `record`. */
async function decide($: Host, name: DecisionName, observations: readonly Observation[], newPrompt?: string) {
  const now = await $.clock.now();
  const session = await sessionId($);
  const engine = makeEngine(settings, hostFetch($));
  const evaluation = await evaluate({
    name,
    observations,
    ...(newPrompt === undefined ? {} : { newPrompt }),
    now,
    engine,
    lock: thresholdsFor(engine, settings.falseAlarmBudget),
    holdoutRate: settings.holdoutRate,
    timeoutMs: settings.timeoutMs,
    cacheTtlSeconds: settings.cacheTtlSeconds,
    agent: AGENT,
    session,
    adapterVersion: VERSION,
    ...(agentVersion ? { agentVersion } : {}),
    startTimer: (ms, onTimeout) => {
      const timer = $.clock.after(ms, onTimeout);
      return () => timer.cancel();
    },
  });
  return { evaluation, session, now };
}

/**
 * Record a decision. When a suggestion chosen to be shown could not reach the
 * user because the moment had passed (a turn started, another suggestion
 * holds the band, no surface draws, no dialog appeared), it is marked
 * "not_shown": the receipt does not count it as seen, but keeps it in the
 * comparison with the held-out moments, as the coin flip assigned it.
 */
async function record($: Host, evaluation: Evaluation, moment: boolean): Promise<void> {
  const event = evaluation.event;
  if (event === undefined) return;
  const due = event.decision.band === "act" && event.decision.suggestion !== undefined && event.decision.holdout !== true;
  if (!moment && due) event.decision.reason = "not_shown";
  tracker.countCheck(event.decision.cost_usd);
  write($, [event]);
  await showStatus($);
}

async function currentBand($: Host): Promise<TwosystemsBand | null> {
  const { value } = await $.state.get(BAND);
  return value ?? null;
}

/** Put a suggestion up, only if none is up. Returns the version it was written at, or null. */
async function claimBand($: Host, band: TwosystemsBand): Promise<number | null> {
  const current = await $.state.get(BAND);
  if (current.value !== undefined && current.value !== null) return null;
  const set = await $.state.set(BAND, band, { ifVersion: current.version });
  return set.isSet ? set.version : null;
}

/** Take the suggestion down, once: of two presses at the same moment, one gets it. */
async function takeBand($: Host): Promise<TwosystemsBand | null> {
  const current = await $.state.get(BAND);
  if (current.value === undefined || current.value === null) return null;
  const set = await $.state.set(BAND, null, { ifVersion: current.version });
  if (!set.isSet) return null;
  await $.ui.close({ id: PANE }).catch(() => undefined);
  return current.value;
}

/** Open the pane that stands in for the band. One that cannot be placed is closed again, so it does not wait undrawn. */
async function openPane($: Host): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: "twosystems" }).catch(() => ({ isPlaced: false }));
  if (!opened.isPlaced) await $.ui.close({ id: PANE }).catch(() => undefined);
  return opened.isPlaced;
}

/** Put a suggestion up in the band (or a pane). Returns false when it could not appear. */
async function putUp($: Host, band: TwosystemsBand, place: Place): Promise<boolean> {
  if (place === "none") return false;
  const version = await claimBand($, band);
  if (version === null) return false;
  if (place === "pane" && !(await openPane($))) {
    await $.state.set(BAND, null, { ifVersion: version }).catch(() => undefined);
    return false;
  }
  return true;
}

/** Show a fresh-start suggestion, and remember it for a /clear or /compact typed soon after. */
async function showSuggestion($: Host, band: TwosystemsBand, place: Place): Promise<boolean> {
  if (!(await putUp($, band, place))) return false;
  tracker.followUp = { decisionId: band.decisionId, session: band.session, suggestion: band.suggestion, at: band.shownAt, tokens: band.tokens };
  tracker.countShown();
  return true;
}

/**
 * Put a held prompt back in the prompt box, after anything typed there since.
 * When the box cannot take it (a dialog holds the keys), the prompt keeps
 * waiting, whole, in the band or pane, so it is never cut short or lost.
 */
async function restoreHeld($: Host, band: TwosystemsBand): Promise<void> {
  const text = band.heldPrompt;
  if (text === null) return;
  const draft = await $.prompt
    .read()
    .then((box) => box.text)
    .catch(() => "");
  const filled = await $.prompt.fill({ text: draft.trim() === "" ? text : `\n${text}`, mode: "append" }).catch(() => ({ isFilled: false }));
  if (filled.isFilled) return;
  const waiting: TwosystemsBand = {
    ...band,
    answered: true,
    message: "twosystems could not put your held prompt back in the prompt box, so it is still waiting here.",
  };
  if (await putUp($, waiting, await placeFor($))) return;
  $.ui.toast(`twosystems could not put your held prompt back in the box. It was: "${text}"`, { timeoutMs: 30_000 });
}

/** Restore a held prompt a moment later, after the command or prompt that displaced it has settled. */
function restoreHeldSoon($: Host, band: TwosystemsBand): void {
  $.clock.after(300, () => {
    void restoreHeld($, band).catch(() => undefined);
  });
}

/** Send a held prompt as the user's own words: Claude reads it bare, as typed. */
async function sendHeld($: Host, text: string): Promise<void> {
  await $.prompt.submit({ text, asUser: true });
}

/** Run the fresh-start check with no new prompt (after a turn, or after an idle spell). */
async function freshStartCheck($: Host, reason: "turn" | "idle"): Promise<void> {
  if (running || !(await hasPerson($))) return;
  const place = await placeFor($);
  if (place === "none" || (await currentBand($)) !== null) return;
  const now = await $.clock.now();
  const tokens = tracker.contextTokens();
  const signals = freshStartSignals({
    observations: tracker.main.observations,
    prompt: "",
    now,
    cacheTtlSeconds: settings.cacheTtlSeconds,
  });
  if (signals.length === 0) return;
  // After a turn only a large conversation can fire, so ask again only when it has grown by half.
  if (reason === "turn" && tracker.lastFreshStartTokens > 0 && tokens < tracker.lastFreshStartTokens * 1.5) return;
  tracker.lastFreshStartTokens = tokens;
  const { evaluation, session } = await decide($, "fresh_start", tracker.main.observations);
  let moment = !running;
  const show = evaluation.show;
  if (moment && (show === "clear" || show === "compact") && evaluation.event !== undefined) {
    moment = await showSuggestion(
      $,
      {
        decisionId: evaluation.event.id,
        session,
        suggestion: show,
        message: bandMessage(show, evaluation.signals, tokens, false),
        tokens,
        heldPrompt: null,
        shownAt: now,
      },
      place,
    );
  }
  await record($, evaluation, moment);
}

function scheduleIdleCheck($: Host): void {
  idleTimer?.cancel();
  idleTimer = $.clock.after(settings.cacheTtlSeconds * 1000 + 30_000, () => {
    idleTimer = null;
    void freshStartCheck($, "idle").catch(() => undefined);
  });
}

/** Record a clear or compact the user took after a suggestion, and remember the size it left. */
async function tookFreshStart($: Host, follow: FollowUp | null, action: "clear" | "compact"): Promise<void> {
  if (follow === null) return;
  tracker.beforeFreshStart = { tokens: follow.tokens, action };
  await recordAction($, follow.session, follow.decisionId, action);
}

/** What a press on the band does. A held prompt is never lost: on any failure it goes back into the prompt box. */
async function press($: Host, choice: Choice): Promise<void> {
  const band = await takeBand($);
  if (band === null) return;
  try {
    await pressed($, band, choice);
  } catch {
    if (band.heldPrompt !== null) await restoreHeld($, band);
    $.ui.toast("twosystems: that did not work; nothing else was changed.");
  }
}

async function pressed($: Host, band: TwosystemsBand, choice: Choice): Promise<void> {
  const held = band.heldPrompt;
  // A suggestion already answered (only its held prompt still waiting) is not answered twice.
  const answer = async (action: UserActionKind) => {
    if (band.answered !== true) await recordAction($, band.session, band.decisionId, action);
  };
  const follow: FollowUp | null =
    band.answered === true
      ? null
      : { decisionId: band.decisionId, session: band.session, suggestion: band.suggestion, at: await $.clock.now(), tokens: band.tokens };
  tracker.followUp = null;
  if (choice === "keep") {
    await answer("keep_going");
    return;
  }
  if (choice === "edit" && held !== null) {
    await answer("dismissed");
    await restoreHeld($, band);
    return;
  }
  if (choice === "send" && held !== null) {
    await answer("continue");
    await sendHeld($, held);
    return;
  }
  if (choice === "clear") {
    // The /clear raises session.end, which records the choice through the follow-up.
    tracker.followUp = follow;
    await $.command.run({ command: "clear" });
    if (tracker.followUp !== null) await tookFreshStart($, tracker.takeFollowUp(await $.clock.now()), "clear");
  } else if (choice === "compact") {
    const result = await $.session.compact();
    if ("skip" in result && result.skip !== undefined) {
      $.ui.toast("twosystems: the compaction did not run.");
      if (held !== null) await restoreHeld($, band);
      return;
    }
    await recordCompaction($, result.usage);
    tracker.compacted();
    await tookFreshStart($, follow, "compact");
  }
  if (held !== null) await sendHeld($, held);
}

/** The suggestion, drawn the same way in the band and in the pane. */
function suggestionTree($: Host, e: Parameters<Host["ui"]["resolve"]>[0], band: TwosystemsBand) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const act = (choice: Choice) => () => {
    void press($, choice).catch(() => undefined);
  };
  const held = band.heldPrompt !== null;
  const clearFirst = band.suggestion === "clear";
  if (held && band.answered === true) {
    // Only the held prompt still waits: the suggestion itself was already answered.
    return (
      <Box flexDirection="column">
        <Text>{band.message}</Text>
        <Text dimColor>{`Waiting: "${excerpt(band.heldPrompt ?? "")}"`}</Text>
        <Box flexDirection="row">
          <Button key="send" label="Send as is" hotkey="s" onPress={act("send")} />
          <Text> </Text>
          <Button key="edit" label="Edit" hotkey="e" onPress={act("edit")} />
        </Box>
      </Box>
    );
  }
  const clear = (
    <Button key="clear" label={held ? "Clear, then send" : "Clear"} hotkey="c" variant={clearFirst ? "primary" : "secondary"} onPress={act("clear")} />
  );
  const compact = (
    <Button key="compact" label={held ? "Compact, then send" : "Compact"} hotkey="m" variant={clearFirst ? "secondary" : "primary"} onPress={act("compact")} />
  );
  return (
    <Box flexDirection="column">
      <Text>{band.message}</Text>
      {held ? <Text dimColor>{`Waiting: "${excerpt(band.heldPrompt ?? "")}"`}</Text> : null}
      <Box flexDirection="row">
        {clearFirst ? clear : compact}
        <Text> </Text>
        {clearFirst ? compact : clear}
        <Text> </Text>
        {held ? <Button key="send" label="Send as is" hotkey="s" onPress={act("send")} /> : <Button key="keep" label="Keep going" hotkey="k" onPress={act("keep")} />}
        {held ? <Text> </Text> : null}
        {held ? <Button key="edit" label="Edit" hotkey="e" onPress={act("edit")} /> : null}
      </Box>
    </Box>
  );
}

export const register: Register = (on, received) => {
  options = received;
  settings = readSettings(received, undefined);

  on("session.start", async ($, e, next) => {
    try {
      await ready($);
      await $.command.register({
        name: "twosystems",
        description: "twosystems: settings, this session, and the receipt of what it cost and saved",
        argumentHint: "[receipt [days]]",
      });
      if (warnings.length > 0 && (e.isInteractive || (await hasPerson($)))) $.ui.toast(`twosystems: ${warnings[0]}`, { timeoutMs: 10_000 });
    } catch {
      // twosystems never stops a session from starting.
    }
    return next(e);
  });

  // The permission mode each loop runs in, so an "ask" is only put where Claude Code shows its dialog.
  on("classic.UserPromptSubmit", async ($, e, next) => {
    noteMode(e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.PostToolUse", async ($, e, next) => {
    noteMode(e);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.PostToolUseFailure", async ($, e, next) => {
    noteMode(e);
    return next(e);
  }).catch(($, e, next) => next(e));

  // Claude Code is about to show its permission dialog: a stuck question waiting on this call is now in front of the user.
  on("classic.PermissionRequest", async ($, e, next) => {
    const result = await next(e);
    try {
      noteMode(e);
      // A hook beneath (a settings hook, another plugin) that answered the request means no dialog appears.
      const answered = result.decision !== undefined || result.block !== undefined || result.preventContinuation !== undefined;
      const pending = answered ? undefined : tracker.askFor(e.agent_id, e.tool_name, e.tool_input);
      if (pending !== undefined) {
        pending.shown = true;
        tracker.countAsked();
      }
    } catch {
      // Observation only.
    }
    return result;
  }).catch(($, e, next) => next(e));

  // Prompts each loop starts with, and the turn bookkeeping of the main loop.
  on("turn.start", async ($, e, next) => {
    const result = await next(e);
    try {
      const at = await $.clock.now();
      if (e.text.trim() !== "") tracker.remember(e.agentId, { kind: "prompt", at, text: e.text });
      if (e.agentId === undefined) {
        running = true;
        idleTimer?.cancel();
        idleTimer = null;
      }
    } catch {
      // Observation only.
    }
    return result;
  });

  // Every tool call: what ran, whether it worked, which files it changed, and
  // the answer to a stuck question put before it.
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    try {
      const at = await $.clock.now();
      const loop = tracker.loop(e.agentId);
      loop.toolCalls += 1;
      const input = e as unknown as Record<string, unknown>;
      const ok = result.deny === undefined && result.isError !== true;
      const observation: Observation = { kind: "tool", at, tool: e.tool, ok };
      const command = toolCommand(input);
      if (command !== undefined) observation.command = command;
      const error = result.deny ?? (result.isError === true ? result.text : undefined);
      if (!ok && error !== undefined) observation.error = error;
      const files = ok ? toolFiles(e.tool, input) : undefined;
      if (files !== undefined) observation.files = files;
      tracker.remember(e.agentId, observation);
      const pending = tracker.pendingAsks.get(e.tool_use_id);
      if (pending !== undefined) {
        tracker.pendingAsks.delete(e.tool_use_id);
        await settleAsk($, pending, askOutcome(result));
      }
    } catch {
      // Observation only.
    }
    return result;
  }).catch(($, e, next) => next(e));

  // The stuck check: Claude Code asks the user before this step when the agent seems stuck.
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    if (e.tool_use_id === undefined || verdict.decision === "deny" || QUESTION_TOOLS.has(e.tool)) return verdict;
    await ready($);
    const mode = modeOf(e.agentId);
    if (mode === undefined || !ASKING_MODES.has(mode) || !(await hasPerson($))) return verdict;
    const evidence = tracker.claimStuckCheck(e.agentId);
    if (evidence === null) return verdict;
    let decided = false;
    let at = await $.clock.now();
    try {
      const { evaluation, session, now } = await decide($, "stuck", evidence);
      decided = evaluation.event !== undefined;
      at = now;
      if (evaluation.show !== "pause" || evaluation.event === undefined) {
        // Held out on purpose, or not confident: recorded now. A held-out moment had its dialog to stand in for.
        await record($, evaluation, true);
      } else {
        tracker.pendingAsks.set(e.tool_use_id, {
          decisionId: evaluation.event.id,
          session,
          loop: tracker.key(e.agentId),
          tool: e.tool,
          input: stableJson(e.input),
          event: evaluation.event,
          shown: false,
        });
        const reason = stuckReason(evaluation.signals);
        if (verdict.decision === "ask") return { ...verdict, reason: verdict.reason ? `${reason}\n\n${verdict.reason}` : reason };
        return { decision: "ask", reason };
      }
    } finally {
      tracker.finishStuckCheck(e.agentId, decided, at);
    }
    return verdict;
  }).catch(($, e, next) => next(e));

  // Exact usage of every main-loop request, and the conversation's size.
  on("turn.step", async function* ($, e, next) {
    const response = yield* next(e);
    try {
      if (e.agentId === undefined && response.usage !== null) {
        const at = await $.clock.now();
        const usage = response.usage;
        const event = exactUsageRecord({ ...source(), session: await sessionId($) }, at, {
          model: usage.model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        });
        write($, [event]);
        const tokens = event.usage.context_tokens ?? 0;
        tracker.remember(undefined, {
          kind: "context",
          at,
          tokens,
          ...(tracker.contextWindow !== undefined ? { window: tracker.contextWindow } : {}),
        });
        if (tracker.beforeFreshStart !== null && tracker.beforeFreshStart.after === undefined) {
          tracker.beforeFreshStart = { ...tracker.beforeFreshStart, after: tokens };
        }
      }
    } catch {
      // Observation only.
    }
    return response;
  });

  // End of a turn: settle unanswered questions, plan the idle check, maybe
  // suggest a fresh start, and add the receipt line under the answer.
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    try {
      if (e.isAborted) {
        for (const pending of tracker.takeAsksOf(e.agentId)) await settleAsk($, pending, "stop");
      }
      if (e.agentId !== undefined) return result;
      running = false;
      if (!(await hasPerson($))) return result;
      await refreshWindow($);
      scheduleIdleCheck($);
      if (e.reason === "answer") {
        $.clock.after(0, () => {
          void freshStartCheck($, "turn").catch(() => undefined);
        });
      }
      if (!settings.receiptLine) return result;
      const before = tracker.beforeFreshStart;
      const saving = before?.after !== undefined ? { action: before.action, before: before.tokens, after: before.after } : null;
      if (saving !== null) tracker.beforeFreshStart = null;
      const line = receiptLine(tracker.sinceLine, tracker.totals, saving);
      if (line !== null) {
        tracker.lineShown();
        return { ...result, text: line };
      }
    } catch {
      // The answer stays as it was.
    }
    return result;
  });

  // A prompt that looks like a new task in a large conversation waits for the user's choice.
  on("prompt.submit", async ($, e, next) => {
    try {
      // The user's own prompt: typed at the terminal, or sent from the Desktop app, VS Code
      // (both arrive as the SDK host's) or a phone. Only terminal prompts are ever held.
      const person = e.origin.kind === "composer" || e.origin.kind === "sdk" || e.origin.kind === "bridge";
      const typed = person && e.command === undefined && e.isMeta !== true;
      if (typed) {
        const band = await takeBand($);
        if (band !== null) {
          // The user sent a prompt instead of pressing a button. A held prompt goes back into the box.
          if (band.heldPrompt !== null) restoreHeldSoon($, band);
          tracker.followUp = null;
          if (band.answered !== true) await recordAction($, band.session, band.decisionId, band.heldPrompt !== null ? "dismissed" : "ignored");
          return next(e);
        }
      }
      const idle = e.turnId === undefined && !running;
      const plain =
        typed && e.origin.kind === "composer" && idle && (e.attachments === undefined || e.attachments.length === 0) && !MENTION.test(e.text);
      if (plain && settings.holdNewTaskPrompts && tracker.contextTokens() >= SIGNAL_RULES.minContextForFreshStart) {
        await ready($);
        const place = await placeFor($);
        const now = await $.clock.now();
        const signals = freshStartSignals({
          observations: tracker.main.observations,
          prompt: e.text,
          now,
          cacheTtlSeconds: settings.cacheTtlSeconds,
        });
        if (place !== "none" && signals.includes("new_prompt_low_overlap")) {
          const tokens = tracker.contextTokens();
          const { evaluation, session } = await decide($, "fresh_start", tracker.main.observations, e.text);
          const show = evaluation.show;
          let moment = true;
          let held = false;
          if ((show === "clear" || show === "compact") && evaluation.event !== undefined) {
            held = await showSuggestion(
              $,
              {
                decisionId: evaluation.event.id,
                session,
                suggestion: show,
                message: bandMessage(show, evaluation.signals, tokens, true),
                tokens,
                heldPrompt: e.text,
                shownAt: now,
              },
              place,
            );
            moment = held;
          }
          await record($, evaluation, moment);
          if (held) {
            return { drop: "twosystems is holding this prompt: it looks like a new task in a large conversation. Choose above the prompt." };
          }
        }
      }
    } catch {
      // On any problem the prompt goes through as typed.
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  // A /clear typed (or pressed) after a suggestion counts as taking it. After a /clear or a
  // /resume a held prompt goes back into the box, and the old conversation's size no longer applies.
  on("session.end", async ($, e, next) => {
    try {
      if (e.reason === "clear" || e.reason === "resume") {
        const band = await takeBand($);
        if (band?.heldPrompt) restoreHeldSoon($, band);
        const follow = tracker.takeFollowUp(await $.clock.now());
        if (e.reason === "clear") await tookFreshStart($, follow, "clear");
        tracker.cleared();
      }
      // Questions still open when the conversation ends were not answered with Yes.
      for (const pending of tracker.takeAsksOf("every")) await settleAsk($, pending, "stop");
      await log.flush();
    } catch {
      // Observation only.
    }
    return next(e);
  });

  // Every main-loop compaction's own request is recorded; a /compact typed after a
  // suggestion counts as taking it. Automatic compaction is not counted as a choice.
  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    try {
      const skipped = "skip" in result && result.skip !== undefined;
      if (e.agentId === undefined && !skipped && e.trigger !== "precompute") {
        tracker.compacted();
        if (e.trigger === "manual") {
          const band = await takeBand($);
          if (band?.heldPrompt) restoreHeldSoon($, band);
          await tookFreshStart($, tracker.takeFollowUp(await $.clock.now()), "compact");
        }
        await recordCompaction($, result.usage);
      }
    } catch {
      // Observation only.
    }
    return result;
  }).catch(($, e, next) => next(e));

  // The pane, closed by the user: the suggestion is dismissed and a held prompt goes back.
  on("ui.close", async ($, e, next) => {
    const result = await next(e);
    try {
      if (e.id === PANE && e.origin.kind === "person") {
        const band = await takeBand($);
        if (band !== null) {
          if (band.heldPrompt !== null) restoreHeldSoon($, band);
          tracker.followUp = null;
          if (band.answered !== true) await recordAction($, band.session, band.decisionId, "dismissed");
        }
      }
    } catch {
      // Observation only.
    }
    return result;
  }).catch(($, e, next) => next(e));

  // The band above the prompt (terminal and Desktop app).
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const band = await currentBand($);
    if (band === null || e.props.hasSurvey || e.props.isWorking) return next(e);
    return suggestionTree($, e, band);
  });

  // The pane that stands in for the band where no band is drawn (VS Code).
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const band = await currentBand($);
    if (band !== null) return suggestionTree($, e, band);
    const { Text } = $.ui.resolve(e);
    return <Text dimColor>twosystems: nothing is waiting for a choice.</Text>;
  });

  // /twosystems: settings, this session, and the receipt.
  on("command.run", { command: "twosystems" }, async ($, e) => {
    await ready($);
    const words = e.args.trim().split(/\s+/).filter((w) => w !== "");
    const asked = words[0] === "receipt" && words[1] !== undefined ? Number(words[1]) : 30;
    const days = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 3650) : 30;
    const engine = makeEngine(settings, hostFetch($));
    const label = `${engine.info.kind}${engine.info.model ? ` (${engine.info.model})` : ""}${settings.engine === "openrouter" && settings.openRouterKey === undefined ? ", no key set" : ""}`;
    const parts = [statusText(settings, label, engine.remote, tracker.totals, [...warnings, ...log.problems.slice(-3)])];
    const now = await $.clock.now();
    const { events, skipped, notes } = await log.readAll(hostFiles($), home);
    const receipt = buildReceipt(events.filter((event) => Date.parse(event.ts) >= now - days * 86_400_000));
    parts.push(formatReceipt(receipt, days));
    if (skipped > 0) parts.push(`Skipped ${skipped} unreadable line(s) in the event log.`);
    parts.push(...notes);
    return { text: parts.join("\n\n") };
  });
};
