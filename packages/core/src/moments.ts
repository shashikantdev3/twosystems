// Moments for calibration: replay a saved session the way the Claude Code
// plugin watches a live one, and keep every moment where it would have asked
// its decision model, with the redacted summary it would have sent and a short
// "what happened next" for the person labelling it. Pure: no files, no network.
// Part of twosystems, created by Shashikant.
import type { Agent, DecisionName, Moment, MomentScore, MomentTrigger } from "./model.js";
import { rememberIn, toolCommand, toolFiles } from "./observations.js";
import { sessionToken } from "./pipeline.js";
import { QUESTIONS, labelsOf, questionHash, sha256 } from "./questions.js";
import { redactAndClip } from "./redact.js";
import { type Observation, SIGNAL_RULES, type SignalName, freshStartSignals, stuckSignals } from "./signals.js";
import { buildState } from "./state.js";
import { timestamp } from "./ids.js";
import type { TimelineEvent } from "./transcript.js";

export const MOMENT_RULES = {
  /** Tool calls between two stuck checks, as in the plugin and the hook command. */
  stuckCheckEvery: 5,
  /** After a turn, the fresh-start check asks again only once the conversation has grown by half, as in the plugin. */
  regrowth: 1.5,
  /** The plugin's idle check runs this long after the prompt cache lifetime has passed. */
  idleGraceMs: 30_000,
  /** Lines of "what happened next" kept with each moment. */
  afterLines: 6,
  /** Longest command, error or prompt text in a "what happened next" line. */
  afterChars: 200,
  /** Longest "what happened next" line in all (the schema allows 400). */
  afterLineChars: 360,
  /** Most scores kept per moment (the schema allows 32). */
  scores: 32,
} as const;

/** Tools that are themselves a question to the user; the plugin never asks before them. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
/** An @ mention: the plugin never holds such a prompt, because a prompt sent again would not expand it. */
const MENTION = /(^|\s)@\S/;
/** Permission modes in which Claude Code shows its dialog, so the plugin asks its stuck question. */
const ASKING_MODES = new Set(["default", "acceptEdits", "plan"]);

export interface MomentOptions {
  agent: Agent;
  session: string;
  /** Prompt cache lifetime used for the cache-expired signal and the idle check, in seconds. */
  cacheTtlSeconds: number;
  /** The session's context window in tokens, as the plugin learns it. Undefined: unknown, as for the hook command. */
  window?: number;
}

type ToolCalls = ReadonlyMap<string, { tool: string; input: Record<string, unknown> }>;

/**
 * Stable id: the same moment read again from the same session gets the same
 * id, even when its summary comes out different (a new version of twosystems,
 * another window), so its label is kept.
 */
export function momentId(decision: DecisionName, trigger: MomentTrigger, session: string, at: number): string {
  return sha256(`${decision}\n${trigger}\n${session}\n${at}`).slice("sha256:".length, "sha256:".length + 32);
}

function describeEvent(event: TimelineEvent, tools: ToolCalls): string | null {
  const clip = (text: string) => redactAndClip(text.replace(/\s+/g, " ").trim(), MOMENT_RULES.afterChars);
  switch (event.kind) {
    case "prompt":
      return `User: ${clip(event.text)}`;
    case "compact":
      return "The conversation was compacted.";
    case "tool_result": {
      const call = tools.get(event.id);
      const name = call?.tool ?? "tool";
      const command = call ? toolCommand(call.input) : undefined;
      const files = call ? toolFiles(call.tool, call.input) : undefined;
      const fileNames = files?.map((f) => f.split(/[\\/]/).at(-1) ?? f).join(", ");
      const what = command ? `${name}: ${clip(command)}` : fileNames ? `${name}: ${clip(fileNames)}` : name;
      if (event.ok) return `${what} -> ok`;
      return `${what} -> failed: ${clip(event.text)}`;
    }
    default:
      return null;
  }
}

/** What happened after the event at `index`, in a few redacted lines. */
function afterOf(events: readonly TimelineEvent[], index: number, tools: ToolCalls): string[] {
  const lines: string[] = [];
  for (let i = index + 1; i < events.length && lines.length < MOMENT_RULES.afterLines; i += 1) {
    const event = events[i];
    if (event === undefined) continue;
    const line = describeEvent(event, tools);
    if (line !== null) lines.push(redactAndClip(line, MOMENT_RULES.afterLineChars));
  }
  if (lines.length < MOMENT_RULES.afterLines && !events.slice(index + 1).some((e) => e.kind === "prompt" || e.kind === "tool_result")) {
    lines.push("(the session ends here)");
  }
  return lines;
}

function moment(
  name: DecisionName,
  trigger: MomentTrigger,
  options: MomentOptions,
  at: number,
  observations: readonly Observation[],
  signals: readonly SignalName[],
  after: string[],
  newPrompt?: string,
): Moment {
  const session = sessionToken(options.session);
  const state = buildState({ name, observations, signals, now: at, ...(newPrompt === undefined ? {} : { newPrompt }) });
  return {
    v: 1,
    id: momentId(name, trigger, session, at),
    decision: name,
    trigger,
    agent: options.agent,
    session,
    at: timestamp(at),
    question_hash: questionHash(QUESTIONS[name]),
    labels: labelsOf(QUESTIONS[name]),
    signals: [...signals],
    state: { lines: state.lines, hash: state.hash },
    after,
    scores: [],
  };
}

/**
 * Replay one session's timeline and return the moments where the Claude Code
 * plugin would have asked its decision model, with the same rules:
 * - stuck, "tool": before a tool call, at most once every five calls, on the
 *   evidence since the last check, when a stuck signal fires;
 * - fresh start, "turn": when a turn ends and a fresh-start signal fires; once
 *   it has asked, it asks again only after the conversation grew by half;
 * - fresh start, "idle": when nothing happened for the prompt cache lifetime
 *   and half a minute after a turn ended, at that point in time;
 * - fresh start, "prompt": when a typed prompt with no @ mention and no pasted
 *   image looks like a new task in a conversation of 20,000 tokens or more,
 *   the moment the plugin holds the prompt.
 * Stuck moments are skipped in a permission mode where Claude Code shows no
 * dialog (when the transcript records the mode). The replay cannot know which
 * suggestions a live session would have shown, so it keeps every moment the
 * rules reach. Subagent loops are left out.
 */
export function findMoments(events: readonly TimelineEvent[], options: MomentOptions): Moment[] {
  const found: Moment[] = [];
  const observations: Observation[] = [];
  const tools = new Map<string, { tool: string; input: Record<string, unknown> }>();
  // Every call in the session, so "what happened next" can name calls made after a moment.
  const allTools = new Map<string, { tool: string; input: Record<string, unknown> }>();
  for (const event of events) if (event.kind === "tool_use") allTools.set(event.id, { tool: event.tool, input: event.input });
  let toolCalls = 0;
  let lastStuckCheck: number | undefined;
  let lastStuckCheckAt: number | undefined;
  let lastFreshStartTokens = 0;
  let turnEndedAt: number | undefined;
  const idleAfterMs = options.cacheTtlSeconds * 1000 + MOMENT_RULES.idleGraceMs;
  const contextTokens = (): number => {
    const last = observations.findLast((o) => o.kind === "context");
    return last?.kind === "context" ? last.tokens : 0;
  };

  // The plugin's fresh-start check with no new prompt, after a turn or an idle spell.
  const checkWithoutPrompt = (trigger: "turn" | "idle", at: number, index: number): void => {
    const signals = freshStartSignals({ observations, prompt: "", now: at, cacheTtlSeconds: options.cacheTtlSeconds });
    if (signals.length === 0) return;
    const tokens = contextTokens();
    if (trigger === "turn" && lastFreshStartTokens > 0 && tokens < lastFreshStartTokens * MOMENT_RULES.regrowth) return;
    lastFreshStartTokens = tokens;
    found.push(moment("fresh_start", trigger, options, at, [...observations], signals, afterOf(events, index, allTools)));
  };

  events.forEach((event, index) => {
    // The plugin's idle timer fires unless a new turn starts first.
    if (event.kind !== "turn_end" && turnEndedAt !== undefined) {
      if (event.at >= turnEndedAt + idleAfterMs) checkWithoutPrompt("idle", turnEndedAt + idleAfterMs, index - 1);
      turnEndedAt = undefined;
    }
    switch (event.kind) {
      case "tool_use": {
        tools.set(event.id, { tool: event.tool, input: event.input });
        if (QUESTION_TOOLS.has(event.tool)) return;
        if (event.mode !== undefined && !ASKING_MODES.has(event.mode)) return;
        const due = lastStuckCheck === undefined || toolCalls - lastStuckCheck >= MOMENT_RULES.stuckCheckEvery;
        if (!due) return;
        const since = lastStuckCheckAt;
        const evidence = observations.filter((o) => o.kind !== "tool" || since === undefined || o.at > since);
        const signals = stuckSignals(evidence);
        if (signals.length === 0) return;
        found.push(moment("stuck", "tool", options, event.at, evidence, signals, afterOf(events, index - 1, allTools)));
        lastStuckCheck = toolCalls;
        lastStuckCheckAt = event.at;
        return;
      }
      case "tool_result": {
        const call = tools.get(event.id);
        if (call === undefined) return;
        toolCalls += 1;
        const observation: Observation = { kind: "tool", at: event.at, tool: call.tool, ok: event.ok };
        const command = toolCommand(call.input);
        if (command !== undefined) observation.command = command;
        if (!event.ok && event.text !== "") observation.error = event.text;
        const files = event.ok ? toolFiles(call.tool, call.input) : undefined;
        if (files !== undefined) observation.files = files;
        rememberIn(observations, observation);
        return;
      }
      case "turn_end":
        // The plugin plans the idle check after every turn, and checks right away only after a full answer.
        turnEndedAt = event.at;
        if (!event.aborted) checkWithoutPrompt("turn", event.at, index);
        return;
      case "prompt": {
        if (!event.images && !MENTION.test(event.text) && contextTokens() >= SIGNAL_RULES.minContextForFreshStart) {
          const signals = freshStartSignals({ observations, prompt: event.text, now: event.at, cacheTtlSeconds: options.cacheTtlSeconds });
          if (signals.includes("new_prompt_low_overlap")) {
            found.push(moment("fresh_start", "prompt", options, event.at, [...observations], signals, afterOf(events, index, allTools), event.text));
          }
        }
        rememberIn(observations, { kind: "prompt", at: event.at, text: event.text });
        return;
      }
      case "context":
        rememberIn(observations, {
          kind: "context",
          at: event.at,
          tokens: event.tokens,
          ...(options.window !== undefined ? { window: options.window } : {}),
        });
        return;
      case "compact":
        // As the plugin does: the old size no longer applies.
        for (let i = observations.length - 1; i >= 0; i -= 1) if (observations[i]?.kind === "context") observations.splice(i, 1);
        lastFreshStartTokens = 0;
        return;
    }
  });
  return found;
}

/** Engine identity as a score records it, for matching scores to an engine. */
export function engineKey(engine: MomentScore["engine"]): string {
  return `${engine.kind}\n${engine.model ?? ""}`;
}

function scoreKey(score: MomentScore): string {
  return `${engineKey(score.engine)}\n${score.engine.model_version ?? ""}\n${score.at}\n${JSON.stringify(score.probabilities)}`;
}

/** The scores of both lists, each once, oldest first, at most 32. */
export function unionScores(a: readonly MomentScore[], b: readonly MomentScore[]): MomentScore[] {
  const byKey = new Map<string, MomentScore>();
  for (const score of [...a, ...b]) if (!byKey.has(scoreKey(score))) byKey.set(scoreKey(score), score);
  const all = [...byKey.values()].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return all.slice(-MOMENT_RULES.scores);
}

/** True when two copies of a moment ask the same question about the same summary, so their scores are interchangeable. */
export function sameSummary(a: Moment, b: Moment): boolean {
  return a.question_hash === b.question_hash && a.state.hash === b.state.hash;
}

/**
 * A stored moment brought up to date with a newer copy of it: everything but
 * the label comes from the newer copy (summary, signals, "what happened
 * next"). The label comes from the stored one, while it is still one of the
 * labels. Scores from both are kept while the question and the summary are the
 * same; otherwise only the newer copy's, because the old ones answered
 * something else.
 */
export function refreshMoment(stored: Moment, newer: Moment): Moment {
  const next: Moment = { ...newer, scores: sameSummary(stored, newer) ? unionScores(stored.scores, newer.scores) : [...newer.scores] };
  delete next.label;
  delete next.labelled_at;
  if (stored.label !== undefined && stored.labelled_at !== undefined && next.labels.includes(stored.label)) {
    next.label = stored.label;
    next.labelled_at = stored.labelled_at;
  }
  return next;
}

/** Time order, then id, so the same moments always give the same file. */
export function byTime(a: Moment, b: Moment): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge freshly found moments into the ones already kept. A moment already
 * known is refreshed (refreshMoment) and keeps its label; `changed` counts
 * those whose question or summary changed, which lose their old scores. New
 * moments are added. Moments no longer found (their session file was deleted)
 * are kept, because a label is work.
 */
export function mergeMoments(
  kept: readonly Moment[],
  fresh: readonly Moment[],
): { moments: Moment[]; added: number; changed: number } {
  const byId = new Map(kept.map((m) => [m.id, m]));
  let added = 0;
  let changed = 0;
  for (const m of fresh) {
    const known = byId.get(m.id);
    if (known === undefined) {
      byId.set(m.id, m);
      added += 1;
      continue;
    }
    if (!sameSummary(known, m)) changed += 1;
    byId.set(m.id, refreshMoment(known, m));
  }
  return { moments: [...byId.values()].sort(byTime), added, changed };
}

/**
 * Put this run's moments onto what is on disk now, which another command (a
 * labelling session) may have changed since this run read it. Labels come
 * from disk; everything else from this run; scores from both while the
 * summary is the same. Moments only on disk are kept.
 */
export function mergeOntoDisk(onDisk: readonly Moment[], mine: readonly Moment[]): Moment[] {
  const byId = new Map(onDisk.map((m) => [m.id, m]));
  for (const m of mine) {
    const disk = byId.get(m.id);
    byId.set(m.id, disk === undefined ? m : refreshMoment(disk, m));
  }
  return [...byId.values()].sort(byTime);
}

/** Copies of one moment found under two session ids share this key. */
export function copyKey(m: Moment): string {
  return `${m.decision}\n${m.trigger ?? ""}\n${m.at}\n${m.state.hash}`;
}

/**
 * Claude Code copies a session's history into a new file when it is forked or
 * resumed, so the same moment can be found under two session ids. Keep one
 * copy, so it is labelled once: an unlabelled copy is dropped when another
 * copy is labelled, else when another copy is already in the file (`saved`
 * holds those ids, so a labelling session never loses the moment it shows),
 * else when another copy's session id sorts first. A labelled moment is never
 * dropped; the fit counts copies once.
 */
export function dropCopies(
  moments: readonly Moment[],
  saved: ReadonlySet<string> = new Set(),
): { moments: Moment[]; dropped: number } {
  const groups = new Map<string, Moment[]>();
  for (const m of moments) {
    const key = copyKey(m);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [m]);
    else group.push(m);
  }
  const rank = (m: Moment) => (saved.has(m.id) ? 0 : 1);
  const kept: Moment[] = [];
  for (const group of groups.values()) {
    const labelled = group.filter((m) => m.label !== undefined);
    if (labelled.length > 0) {
      kept.push(...labelled);
      continue;
    }
    const [first] = [...group].sort(
      (a, b) => rank(a) - rank(b) || (a.session < b.session ? -1 : a.session > b.session ? 1 : byTime(a, b)),
    );
    if (first !== undefined) kept.push(first);
  }
  return { moments: kept.sort(byTime), dropped: moments.length - kept.length };
}
