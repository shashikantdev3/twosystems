// Receipt maths: what twosystems did, what it cost, and what it saved.
// Three figures, never mixed up: our own cost (exact), an estimate (labelled as
// one), and a verified figure from the random holdout that is shown only when
// its confidence interval clears zero.
// Part of twosystems, created by Shashikant.
import type { Band, TwoSystemsEvent, Usage } from "./model.js";

type DecisionEvent = TwoSystemsEvent & { type: "decision" };
type UsageEvent = TwoSystemsEvent & { type: "usage" };

/** Settings for the verified figure. */
export const RECEIPT_RULES = {
  /** Fewest moments needed in each group (shown and held out) before comparing them. */
  minPerGroup: 20,
  /** How long after a moment its usage counts towards the outcome. */
  windowMinutes: 60,
  /** Bootstrap resamples for the confidence interval. */
  resamples: 2000,
  /** Requests after an accepted suggestion that the estimate counts at most. */
  maxRequestsCounted: 50,
} as const;

export interface Interval {
  mean: number;
  low: number;
  high: number;
}

export interface Receipt {
  sessions: number;
  decisions: {
    total: number;
    byBand: Record<Band, number>;
    /** Suggestions the user saw. */
    shown: number;
    /** Suggestions due to be shown whose moment passed before they could appear. */
    notShown: number;
    /** Moments where a suggestion was due but held back on purpose. */
    heldOut: number;
  };
  actions: { accepted: number; declined: number };
  /** What twosystems itself spent on decision models, in US dollars. */
  ownCostUsd: number;
  /** Context tokens not sent again after accepted suggestions. An estimate, not a measurement. */
  estimatedTokensSaved: number;
  verified:
    | { status: "not_enough_data"; shown: number; heldOut: number; needed: number }
    | { status: "no_clear_effect" | "verified"; unit: "usd" | "tokens"; perMoment: Interval; shown: number; heldOut: number };
}

function ms(ts: string): number {
  return Date.parse(ts);
}

/** Tokens a request used: everything sent and received, or the context size when that is all we know. */
export function requestTokens(usage: Usage): number {
  const parts = [usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens];
  const known = parts.filter((p): p is number => p !== undefined);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : (usage.context_tokens ?? 0);
}

/** Small, fast, seedable random numbers so the same log always gives the same receipt. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Index of the first usage record strictly after the given time. The list is in time order.
function firstAfter(series: readonly UsageEvent[], at: number): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms((series[mid] as UsageEvent).ts) <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: readonly number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (index - lo);
}

/**
 * Difference in means, control minus treated, with a 95% percentile bootstrap
 * interval. Positive means the treated group used less.
 */
export function bootstrapSaving(
  control: readonly number[],
  treated: readonly number[],
  resamples: number = RECEIPT_RULES.resamples,
  random: () => number = seededRandom(control.length * 7919 + treated.length),
): Interval {
  const pick = (values: readonly number[]) => {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += values[Math.floor(random() * values.length)] ?? 0;
    return sum / values.length;
  };
  const diffs: number[] = [];
  for (let r = 0; r < resamples; r += 1) diffs.push(pick(control) - pick(treated));
  diffs.sort((a, b) => a - b);
  return { mean: mean(control) - mean(treated), low: percentile(diffs, 0.025), high: percentile(diffs, 0.975) };
}

function groupBy(list: readonly UsageEvent[], key: (u: UsageEvent) => string): Map<string, UsageEvent[]> {
  const groups = new Map<string, UsageEvent[]>();
  for (const u of list) {
    const k = key(u);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [u]);
    else group.push(u);
  }
  return groups;
}

/**
 * Build a receipt from events, which may come from many sessions and agents.
 *
 * After a /clear the agent starts a new session, so what happens after a
 * moment is followed per agent, across sessions, not per session. Other
 * sessions of the same agent in that hour add noise to both groups equally,
 * because the holdout is random; they do not bias the comparison. Moments less
 * than an hour apart share some usage, which can make the interval narrower
 * than it should be; Sprint 5 refines the method before the figure is relied on.
 */
export function buildReceipt(events: readonly TwoSystemsEvent[]): Receipt {
  const sorted = [...events].sort((a, b) => ms(a.ts) - ms(b.ts));
  const decisions = sorted.filter((e): e is DecisionEvent => e.type === "decision");
  const usage = sorted.filter((e): e is UsageEvent => e.type === "usage");
  const usageBySession = groupBy(usage, (u) => `${u.agent}\n${u.session}`);
  const usageByAgent = groupBy(usage, (u) => u.agent);
  // Only measured usage counts towards the verified figure, never estimates.
  const exactByAgent = groupBy(
    usage.filter((u) => u.usage.source === "exact"),
    (u) => u.agent,
  );
  const windowMs = RECEIPT_RULES.windowMinutes * 60_000;
  const within = (series: readonly UsageEvent[], from: number) =>
    series.slice(firstAfter(series, from), firstAfter(series, from + windowMs));

  const byBand: Record<Band, number> = { act: 0, unsure: 0, silent: 0, not_evaluated: 0 };
  let ownCostUsd = 0;
  const decisionById = new Map<string, DecisionEvent>();
  for (const d of decisions) {
    byBand[d.decision.band] += 1;
    ownCostUsd += d.decision.cost_usd ?? 0;
    decisionById.set(d.id, d);
  }
  // Every moment the coin was flipped for stays in the comparison, as it was
  // assigned: dropping moments from one group after the flip would bias it. A
  // suggestion whose moment passed before it could appear (reason "not_shown")
  // is therefore still in the shown group; it only waters the effect down, and
  // it is not counted as a suggestion the user saw.
  const due = decisions.filter((d) => d.decision.band === "act" && d.decision.suggestion !== undefined);
  const assigned = due.filter((d) => !d.decision.holdout);
  const heldOut = due.filter((d) => d.decision.holdout);
  const notShown = assigned.filter((d) => d.decision.reason === "not_shown").length;

  // Estimate: when the user cleared or compacted after a suggestion, the context
  // that shrank is not sent again with each later request in the next hour.
  // When a session's requests started, so a clear can be followed into the new
  // session it opens without counting other windows that were already running.
  const sessionStart = new Map<string, number>();
  for (const u of usage) {
    const k = `${u.agent}\n${u.session}`;
    if (!sessionStart.has(k)) sessionStart.set(k, ms(u.ts));
  }
  let accepted = 0;
  let declined = 0;
  let estimatedTokensSaved = 0;
  const answered = new Set<string>();
  for (const action of sorted) {
    if (action.type !== "user_action") continue;
    const source = decisionById.get(action.user_action.decision_id);
    // Each suggestion counts once, by the user's first answer to it.
    if (source === undefined || answered.has(source.id)) continue;
    answered.add(source.id);
    const taken = action.user_action.action;
    if (taken === "dismissed" || taken === "ignored" || taken === "keep_going" || taken === "continue") {
      declined += 1;
      continue;
    }
    accepted += 1;
    if (taken !== "clear" && taken !== "compact") continue;
    const at = ms(action.ts);
    const own = usageBySession.get(`${source.agent}\n${source.session}`) ?? [];
    const before = own.slice(0, firstAfter(own, at)).findLast((u) => u.usage.context_tokens !== undefined);
    const after = within(usageByAgent.get(source.agent) ?? [], at)
      .filter((u) => u.session === source.session || (sessionStart.get(`${u.agent}\n${u.session}`) ?? 0) > at)
      .slice(0, RECEIPT_RULES.maxRequestsCounted);
    const next = after.find((u) => u.usage.context_tokens !== undefined);
    if (before === undefined || next === undefined) continue;
    const shrink = Math.max(0, (before.usage.context_tokens ?? 0) - (next.usage.context_tokens ?? 0));
    estimatedTokensSaved += shrink * after.length;
  }

  const sessions = new Set(sorted.map((e) => `${e.agent}\n${e.session}`)).size;
  const base = {
    sessions,
    decisions: { total: decisions.length, byBand, shown: assigned.length - notShown, notShown, heldOut: heldOut.length },
    actions: { accepted, declined },
    ownCostUsd,
    estimatedTokensSaved,
  };

  // Verified: compare what the agent used in the hour after a suggestion chosen to be
  // shown with the hour after a held-back one, for agents that report measured usage.
  const measured = (d: DecisionEvent) => exactByAgent.has(d.agent);
  const shownMeasured = assigned.filter(measured);
  const heldMeasured = heldOut.filter(measured);
  if (shownMeasured.length < RECEIPT_RULES.minPerGroup || heldMeasured.length < RECEIPT_RULES.minPerGroup) {
    return {
      ...base,
      verified: { status: "not_enough_data", shown: shownMeasured.length, heldOut: heldMeasured.length, needed: RECEIPT_RULES.minPerGroup },
    };
  }
  const following = (d: DecisionEvent) => within(exactByAgent.get(d.agent) ?? [], ms(d.ts));
  const all = [...shownMeasured, ...heldMeasured].flatMap(following);
  const unit: "usd" | "tokens" = all.length > 0 && all.every((u) => u.usage.cost_usd !== undefined) ? "usd" : "tokens";
  const outcome = (d: DecisionEvent) =>
    following(d).reduce((sum, u) => sum + (unit === "usd" ? (u.usage.cost_usd ?? 0) : requestTokens(u.usage)), 0);
  const perMoment = bootstrapSaving(heldMeasured.map(outcome), shownMeasured.map(outcome));
  return {
    ...base,
    verified: {
      status: perMoment.low > 0 ? "verified" : "no_clear_effect",
      unit,
      perMoment,
      shown: shownMeasured.length,
      heldOut: heldMeasured.length,
    },
  };
}
