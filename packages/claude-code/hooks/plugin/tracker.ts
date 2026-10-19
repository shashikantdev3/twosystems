// What the plugin remembers about the running session: recent observations
// per loop (the main conversation and each subagent), when the last stuck
// check ran, questions waiting for an answer, and this session's totals.
// It lives in the module, so a reload of the plugin starts it afresh.
// Part of twosystems, created by Shashikant.
import { type Observation, type TwoSystemsEvent, type UserActionKind, rememberIn } from "../core/portable.js";

/** Tool calls between two model checks for stuck in one loop, as in the hook command. */
export const STUCK_CHECK_EVERY = 5;
/** How long a shown fresh-start suggestion waits for a typed /clear or /compact. */
export const FOLLOW_UP_MS = 15 * 60_000;
/** Subagent loops remembered at most; the oldest is forgotten first. */
const MAX_LOOPS = 32;

export interface Loop {
  observations: Observation[];
  toolCalls: number;
  lastStuckCheck?: number;
  lastStuckCheckAt?: number;
  /** A stuck check is running for this loop, so a parallel call does not start another. */
  checking: boolean;
}

/**
 * A stuck question handed to Claude Code, waiting for the tool call's outcome.
 * Its decision record waits too: it is written as shown only once Claude Code
 * says its permission dialog appeared.
 */
export interface PendingAsk {
  decisionId: string;
  session: string;
  loop: string;
  tool: string;
  /** The call's input as `stableJson` writes it, to tell parallel calls of one tool apart. */
  input: string;
  event: TwoSystemsEvent & { type: "decision" };
  shown: boolean;
}

/** JSON with object keys sorted, so two equal inputs always compare equal. */
export function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    ) ?? ""
  );
}

/** A fresh-start suggestion the user may still take by typing /clear or /compact. */
export interface FollowUp {
  decisionId: string;
  session: string;
  suggestion: "clear" | "compact";
  at: number;
  tokens: number;
}

/** What twosystems did since the last receipt line. */
export interface Activity {
  checks: number;
  costUsd: number;
  asked: number;
  shown: number;
}

const MAIN = "main";
const none = (): Activity => ({ checks: 0, costUsd: 0, asked: 0, shown: 0 });

export class Tracker {
  private readonly loops = new Map<string, Loop>();
  readonly pendingAsks = new Map<string, PendingAsk>();
  followUp: FollowUp | null = null;
  /** Context size before a fresh start the user took, and after it once known, to report the difference once. */
  beforeFreshStart: { tokens: number; action: "clear" | "compact"; after?: number } | null = null;
  /** Size of the context window, once the session has said. */
  contextWindow: number | undefined;
  /** Context size when the last fresh-start check ran, so a growing chat is not checked every turn. */
  lastFreshStartTokens = 0;
  /** This session's totals. */
  totals: Activity = none();
  /** What happened since the last receipt line, shown under the next answer. */
  sinceLine: Activity = none();

  loop(agentId: string | undefined): Loop {
    const key = agentId ?? MAIN;
    let loop = this.loops.get(key);
    if (loop === undefined) {
      loop = { observations: [], toolCalls: 0, checking: false };
      this.loops.set(key, loop);
      if (this.loops.size > MAX_LOOPS) {
        for (const old of this.loops.keys()) {
          if (old === MAIN || old === key) continue;
          this.loops.delete(old);
          break;
        }
      }
    }
    return loop;
  }

  key(agentId: string | undefined): string {
    return agentId ?? MAIN;
  }

  get main(): Loop {
    return this.loop(undefined);
  }

  remember(agentId: string | undefined, observation: Observation): void {
    rememberIn(this.loop(agentId).observations, observation);
  }

  /** The last context size the main conversation reported, or 0. */
  contextTokens(): number {
    const last = this.main.observations.findLast((o) => o.kind === "context");
    return last?.kind === "context" ? last.tokens : 0;
  }

  /**
   * Claim the stuck check for a loop if it is due. Only tool calls after the
   * last check count as evidence, so an allowed step is not asked about again
   * on the same old failures. Returns the evidence, or null when not due.
   */
  claimStuckCheck(agentId: string | undefined): Observation[] | null {
    const loop = this.loop(agentId);
    const due = loop.lastStuckCheck === undefined || loop.toolCalls - loop.lastStuckCheck >= STUCK_CHECK_EVERY;
    if (!due || loop.checking || [...this.pendingAsks.values()].some((p) => p.loop === this.key(agentId))) return null;
    loop.checking = true;
    const since = loop.lastStuckCheckAt;
    return loop.observations.filter((o) => o.kind !== "tool" || since === undefined || o.at > since);
  }

  /** Finish a claimed check; `decided` is false when no signal fired and no record was made. */
  finishStuckCheck(agentId: string | undefined, decided: boolean, at: number): void {
    const loop = this.loop(agentId);
    loop.checking = false;
    if (!decided) return;
    loop.lastStuckCheck = loop.toolCalls;
    loop.lastStuckCheckAt = at;
  }

  /**
   * The stuck question a permission dialog is about to show: the open one in
   * that loop for the same tool and the same input. Claude Code's permission
   * request carries no call id, so the input tells parallel calls apart.
   */
  askFor(agentId: string | undefined, tool: string, input: unknown): PendingAsk | undefined {
    const loop = this.key(agentId);
    const key = stableJson(input);
    for (const pending of this.pendingAsks.values()) {
      if (pending.loop === loop && pending.tool === tool && !pending.shown && pending.input === key) return pending;
    }
    return undefined;
  }

  /** Take the pending asks of a loop (or of every loop), for a turn or session that ended first. */
  takeAsksOf(agentId: string | undefined | "every"): PendingAsk[] {
    const key = agentId === "every" ? null : this.key(agentId);
    const taken: PendingAsk[] = [];
    for (const [id, pending] of this.pendingAsks) {
      if (key !== null && pending.loop !== key) continue;
      taken.push(pending);
      this.pendingAsks.delete(id);
    }
    return taken;
  }

  /**
   * The follow-up for a /clear or /compact the user took, if a suggestion was
   * shown recently; it is used up. Either action counts as acting on it.
   */
  takeFollowUp(now: number): FollowUp | null {
    const follow = this.followUp;
    this.followUp = null;
    if (follow === null || now - follow.at > FOLLOW_UP_MS) return null;
    return follow;
  }

  /** The main conversation was cleared: forget it, keep the session's totals. */
  cleared(): void {
    this.loops.delete(MAIN);
    this.lastFreshStartTokens = 0;
  }

  /** The main conversation was compacted: its old size no longer applies. */
  compacted(): void {
    this.main.observations = this.main.observations.filter((o) => o.kind !== "context");
    this.lastFreshStartTokens = 0;
  }

  countCheck(costUsd: number | undefined): void {
    for (const activity of [this.totals, this.sinceLine]) {
      activity.checks += 1;
      if (costUsd !== undefined) activity.costUsd += costUsd;
    }
  }

  countAsked(): void {
    this.totals.asked += 1;
    this.sinceLine.asked += 1;
  }

  countShown(): void {
    this.totals.shown += 1;
    this.sinceLine.shown += 1;
  }

  /** Start counting again after a receipt line was shown. */
  lineShown(): void {
    this.sinceLine = none();
  }
}

/** Claude Code's own words when the user says No in the permission dialog or interrupts the call. */
const USER_REFUSED = /doesn't want to proceed with this tool use|tool use was rejected|interrupted by user/i;

/**
 * How a stuck question was answered, read from the tool call's outcome. A
 * failing tool is still a step the user let run; only Claude Code's own
 * refusal wording, or a refusal by a hook, counts as stopping.
 */
export function askOutcome(result: { deny?: string; isError?: boolean; text?: string }): UserActionKind {
  if (result.deny !== undefined) return "stop";
  if (result.isError === true && USER_REFUSED.test(result.text ?? "")) return "stop";
  return "keep_going";
}
