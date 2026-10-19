// What one hook call does: update the session notes, run a check when its
// moment comes, record events, and build the reply for the agent.
// Notes are changed under a short lock; the decision model is called outside
// it, so parallel hooks of the same session never wait for a model.
// Part of twosystems, created by Shashikant.
import type { Agent, TwoSystemsEvent, UserActionKind } from "./contracts.js";
import { type Config, cacheTtlFor } from "./config.js";
import type { DecisionEngine } from "./engines/types.js";
import { appendEvent, isToken, newId, timestamp } from "./eventlog.js";
import {
  type HookInput,
  type HookOutput,
  type TranscriptUsage,
  askBeforeTool,
  lastTranscriptUsage,
  parseHookPayload,
  showNote,
} from "./hooks.js";
import type { LoadedLock } from "./lock.js";
import { evaluate, sessionToken } from "./pipeline.js";
import {
  type SessionNotes,
  pruneNotes,
  remember,
  savePendingClear,
  takePendingClear,
  updateNotes,
} from "./sessions.js";
import type { Observation, SignalName } from "./signals.js";

/** Tool calls between two stuck checks in one session. */
export const STUCK_CHECK_EVERY = 5;
/** A claimed stuck check that never finished (the hook was killed) is given up after this. */
const CLAIM_EXPIRES_MS = 20_000;
/** How long a shown fresh-start suggestion waits for the user to clear or compact. */
export const FRESH_START_FOLLOW_UP_MS = 15 * 60_000;
/** Agents known to show a note sent in reply to a prompt hook. */
const PROMPT_NOTES_SHOWN_BY: Record<Agent, boolean> = {
  "claude-code": true,
  codex: true,
  copilot: false,
  cursor: false,
  windsurf: false,
  other: false,
};
/** Share of the estimated size left after a compaction. */
const AFTER_COMPACT = 0.1;

export interface HookContext {
  config: Config;
  engine: DecisionEngine;
  lock: LoadedLock;
  agent: Agent;
  adapterVersion: string;
  now: number;
  random?: () => number;
}

export interface HookResult {
  output: HookOutput;
  events: TwoSystemsEvent[];
}

const SIGNAL_TEXT: Record<SignalName, string> = {
  repeated_command: "the same command keeps failing",
  repeated_error: "the same error keeps coming back",
  no_file_change: "no file has changed for a while",
  many_tool_calls: "many steps without a new prompt",
  large_context: "the conversation is large",
  cache_expired: "the prompt cache has probably expired",
  new_prompt_low_overlap: "the new prompt looks like a different task",
};

function describe(signals: readonly SignalName[]): string {
  return signals.map((s) => SIGNAL_TEXT[s]).join("; ");
}

function thousands(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** Message for a stuck suggestion, shown when the agent asks before its next step. */
export function stuckMessage(signals: readonly SignalName[]): string {
  return `twosystems: the agent may be stuck (${describe(signals)}). Allow this step to keep going, or deny it and give the agent a hint.`;
}

/** Message for a fresh-start suggestion, worded for the agent's own commands. */
export function freshStartMessage(agent: Agent, suggestion: "clear" | "compact", signals: readonly SignalName[], tokens: number): string {
  const size = tokens > 0 ? ` The conversation holds about ${thousands(tokens)} tokens, sent again with every request.` : "";
  const action =
    agent === "claude-code"
      ? suggestion === "clear"
        ? "Before your next prompt, /clear would start fresh"
        : "Before your next prompt, /compact would keep a summary and drop the rest"
      : suggestion === "clear"
        ? "Before your next prompt, a new chat would start fresh"
        : "Before your next prompt, a new chat with a short summary would keep what matters";
  return `twosystems: ${describe(signals)}.${size} ${action}.`;
}

function base(ctx: HookContext, session: string, at: number) {
  return {
    v: 1 as const,
    id: newId(),
    ts: timestamp(at),
    agent: ctx.agent,
    session: sessionToken(session),
    adapter_version: ctx.adapterVersion,
  };
}

function userAction(ctx: HookContext, session: string, at: number, decisionId: string, action: UserActionKind): TwoSystemsEvent {
  return { ...base(ctx, session, at), type: "user_action", user_action: { decision_id: decisionId, action } };
}

function lastContextTokens(observations: readonly Observation[]): number {
  const context = observations.findLast((o) => o.kind === "context");
  return context?.kind === "context" ? context.tokens : 0;
}

/**
 * Record the conversation size: what the agent reports, else the Claude Code
 * transcript, else a rough estimate. A size read now describes the last
 * request, so it is stamped with that request's time (or the last thing seen),
 * never with the current time: otherwise every idle gap would look like zero.
 */
function recordContext(
  ctx: HookContext,
  input: HookInput,
  notes: SessionNotes,
  transcript: TranscriptUsage | null,
  events: TwoSystemsEvent[],
): void {
  const lastSeen = notes.observations.at(-1)?.at ?? input.at;
  if (input.contextTokens !== undefined) {
    rememberSize(notes, input.at, input.contextTokens);
    return;
  }
  if (transcript !== null) {
    const at = transcript.at !== undefined && transcript.at <= input.at ? transcript.at : lastSeen;
    rememberSize(notes, at, transcript.contextTokens);
    const key = transcript.requestId ?? `${transcript.contextTokens}:${transcript.outputTokens}`;
    if (key !== notes.lastUsageKey) {
      notes.lastUsageKey = key;
      const usage: TwoSystemsEvent & { type: "usage" } = {
        ...base(ctx, input.session, at),
        type: "usage",
        usage: {
          source: "exact",
          input_tokens: transcript.inputTokens,
          output_tokens: transcript.outputTokens,
          cache_read_tokens: transcript.cacheReadTokens,
          cache_write_tokens: transcript.cacheWriteTokens,
          context_tokens: transcript.contextTokens,
        },
      };
      if (transcript.model !== undefined && isToken(transcript.model)) usage.usage.model = transcript.model;
      if (transcript.requestId !== undefined && isToken(transcript.requestId)) usage.usage.request_id = transcript.requestId;
      events.push(usage);
    }
    return;
  }
  if (notes.estimatedTokens > 0) {
    const tokens = Math.round(notes.estimatedTokens);
    remember(notes, { kind: "context", at: lastSeen, tokens });
    // Agents that never report sizes get estimated usage records, labelled as estimates.
    if (notes.sizeReported !== true) {
      events.push({ ...base(ctx, input.session, input.at), type: "usage", usage: { source: "estimate", context_tokens: tokens } });
    }
  }
}

/** A size the agent reported: remember it, and restart the running estimate from it. */
function rememberSize(notes: SessionNotes, at: number, tokens: number): void {
  remember(notes, { kind: "context", at, tokens });
  notes.estimatedTokens = tokens;
  notes.sizeReported = true;
}

/** Handle one hook call. Writes no events itself: the caller appends the returned events. */
export async function handleHook(payload: unknown, eventFlag: string | undefined, ctx: HookContext): Promise<HookResult> {
  const input = parseHookPayload(payload, eventFlag, ctx.now);
  if (input === null) return { output: {}, events: [] };
  const { config, agent } = ctx;
  const dir = config.sessionsDir;
  const events: TwoSystemsEvent[] = [];
  let output: HookOutput = {};
  const update = <T>(change: (notes: SessionNotes) => T) => updateNotes(dir, agent, input.session, change);

  const common = {
    engine: ctx.engine,
    lock: ctx.lock,
    holdoutRate: config.holdoutRate,
    timeoutMs: config.timeoutMs,
    agent,
    session: input.session,
    adapterVersion: ctx.adapterVersion,
    now: input.at,
    ...(ctx.random ? { random: ctx.random } : {}),
  };
  const wantsTranscript = (input.event === "prompt" || input.event === "stop") && input.transcriptPath !== undefined && agent === "claude-code";
  const transcript = wantsTranscript && input.transcriptPath !== undefined ? await lastTranscriptUsage(input.transcriptPath) : null;

  switch (input.event) {
    case "session_start": {
      // Only a /clear typed by the user starts a session with source "clear". Automatic
      // compaction also starts one with source "compact", so compaction is judged by PreCompact.
      if (input.source === "clear" && input.cwd !== undefined) {
        const pending = await takePendingClear(dir, agent, input.cwd, input.at, FRESH_START_FOLLOW_UP_MS);
        if (pending !== null) events.push(userAction(ctx, pending.session, input.at, pending.decisionId, "clear"));
      }
      await update((notes) => {
        if (input.contextTokens !== undefined) rememberSize(notes, input.at, input.contextTokens);
        if (input.cacheExpired !== undefined) notes.cacheHint = { expired: input.cacheExpired, at: input.at };
        if (input.source === "compact") notes.estimatedTokens *= AFTER_COMPACT;
      });
      break;
    }
    case "pre_compact": {
      await update((notes) => {
        const pending = notes.pendingFreshStart;
        if (input.trigger === "manual" && pending !== undefined && input.at - pending.at <= FRESH_START_FOLLOW_UP_MS) {
          events.push(userAction(ctx, input.session, input.at, pending.decisionId, "compact"));
          delete notes.pendingFreshStart;
        }
        notes.estimatedTokens *= AFTER_COMPACT;
      });
      break;
    }
    case "prompt": {
      const prompt = input.prompt ?? "";
      const before = await update((notes) => {
        if (notes.pendingAsk !== undefined) {
          // Asked about being stuck, and the user wrote a new prompt instead of letting the step run.
          events.push(userAction(ctx, input.session, input.at, notes.pendingAsk.decisionId, "stop"));
          delete notes.pendingAsk;
        }
        recordContext(ctx, input, notes, transcript, events);
        const hint = input.cacheExpired ?? notes.cacheHint?.expired;
        delete notes.cacheHint;
        delete notes.lastStuckCheck;
        delete notes.lastStuckCheckAt;
        return { observations: [...notes.observations], hint };
      });
      // A suggestion nobody can see must not be made, counted or paid for. The
      // Copilot CLI drops replies to prompt hooks, and VS Code and the CLI share one
      // hook file, so for Copilot the check waits until a live test shows the note
      // in VS Code.
      let shown: { id: string; suggestion: "clear" | "compact" } | undefined;
      if (input.promptNotesShown && PROMPT_NOTES_SHOWN_BY[agent]) {
        const { observations, hint } = before.result;
        const ttl = hint === true ? 0 : hint === false ? Number.POSITIVE_INFINITY : cacheTtlFor(config, agent);
        const evaluation = await evaluate({ ...common, name: "fresh_start", observations, newPrompt: prompt, cacheTtlSeconds: ttl });
        if (evaluation.event !== undefined) events.push(evaluation.event);
        if ((evaluation.show === "clear" || evaluation.show === "compact") && evaluation.event !== undefined) {
          shown = { id: evaluation.event.id, suggestion: evaluation.show };
          output = showNote(input, freshStartMessage(agent, evaluation.show, evaluation.signals, lastContextTokens(observations)));
        }
      }
      if (shown?.suggestion === "clear" && input.cwd !== undefined) {
        await savePendingClear(dir, input.cwd, { decisionId: shown.id, agent, session: input.session, suggestion: "clear", at: input.at });
      }
      await update((notes) => {
        if (shown !== undefined) {
          notes.pendingFreshStart = { decisionId: shown.id, agent, session: input.session, suggestion: shown.suggestion, at: input.at };
        }
        remember(notes, { kind: "prompt", at: input.at, text: prompt });
        notes.estimatedTokens += prompt.length / 4;
      });
      break;
    }
    case "pre_tool": {
      // Claim the check under the lock first, so two hooks of the same session
      // running at once never both pay for a model call.
      const { result: claim } = await update((notes) => {
        const due = notes.lastStuckCheck === undefined || notes.toolCalls - notes.lastStuckCheck >= STUCK_CHECK_EVERY;
        const busy = notes.stuckCheckClaimedAt !== undefined && ctx.now - notes.stuckCheckClaimedAt < CLAIM_EXPIRES_MS;
        if (!due || busy || notes.pendingAsk !== undefined) return null;
        notes.stuckCheckClaimedAt = ctx.now;
        // Only tool calls after the last check count as evidence, so an allowed step
        // is not questioned again on the same old failures.
        const since = notes.lastStuckCheckAt;
        return notes.observations.filter((o) => o.kind !== "tool" || since === undefined || o.at > since);
      });
      if (claim === null) break;
      const evaluation = await evaluate({ ...common, name: "stuck", observations: claim, cacheTtlSeconds: cacheTtlFor(config, agent) });
      const decision = evaluation.event;
      await update((notes) => {
        delete notes.stuckCheckClaimedAt;
        if (decision === undefined) return;
        notes.lastStuckCheck = notes.toolCalls;
        notes.lastStuckCheckAt = input.at;
        if (evaluation.show !== undefined) {
          notes.pendingAsk = { decisionId: decision.id, at: input.at, ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}) };
        }
      });
      if (decision === undefined) break;
      events.push(decision);
      if (evaluation.show !== undefined) output = askBeforeTool(input, stuckMessage(evaluation.signals));
      break;
    }
    case "post_tool":
    case "post_tool_failure": {
      await update((notes) => {
        const pending = notes.pendingAsk;
        if (pending !== undefined && (pending.toolUseId === undefined || pending.toolUseId === input.toolUseId)) {
          events.push(userAction(ctx, input.session, input.at, pending.decisionId, "keep_going"));
          delete notes.pendingAsk;
        }
        remember(notes, {
          kind: "tool",
          at: input.at,
          tool: input.toolName ?? "tool",
          ok: input.ok ?? true,
          ...(input.command !== undefined ? { command: input.command } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.files !== undefined ? { files: input.files } : {}),
        });
        notes.toolCalls += 1;
        // A rough guess at what the call added to the conversation, used only when the agent reports no sizes.
        notes.estimatedTokens += 200 + ((input.command?.length ?? 0) + (input.error?.length ?? 0)) / 4;
      });
      break;
    }
    case "permission_denied": {
      await update((notes) => {
        if (notes.pendingAsk !== undefined) {
          events.push(userAction(ctx, input.session, input.at, notes.pendingAsk.decisionId, "stop"));
          delete notes.pendingAsk;
        }
      });
      break;
    }
    case "stop": {
      if (transcript !== null) await update((notes) => recordContext(ctx, input, notes, transcript, events));
      break;
    }
    default:
      break;
  }

  await pruneNotes(dir, ctx.now);
  return { output, events };
}

/** Append the events a hook call produced. */
export async function recordEvents(path: string, events: readonly TwoSystemsEvent[]): Promise<void> {
  for (const event of events) await appendEvent(path, event);
}
