// Event records an adapter writes besides decisions: token usage and what the
// user did with a suggestion. Shared by every adapter so the records always
// fit events.schema.json; tests check them against the schema.
// Part of twosystems, created by Shashikant.
import { isToken, newId, timestamp } from "./ids.js";
import type { Agent, TwoSystemsEvent, Usage, UserActionKind } from "./model.js";
import { sessionToken } from "./pipeline.js";

/** Who is writing: the agent, its session, and the adapter's version. */
export interface RecordSource {
  agent: Agent;
  session: string;
  agentVersion?: string;
  adapterVersion?: string;
}

function base(source: RecordSource, at: number) {
  const record: {
    v: 1;
    id: string;
    ts: string;
    agent: Agent;
    session: string;
    agent_version?: string;
    adapter_version?: string;
  } = { v: 1, id: newId(), ts: timestamp(at), agent: source.agent, session: sessionToken(source.session) };
  if (source.agentVersion !== undefined && isToken(source.agentVersion)) record.agent_version = source.agentVersion;
  if (source.adapterVersion !== undefined && isToken(source.adapterVersion)) record.adapter_version = source.adapterVersion;
  return record;
}

/** A count the schema accepts: a whole number, zero or more. */
function count(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** The usage of one model request, as the agent reported it. */
export interface RequestUsage {
  model?: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/**
 * An exact usage record for one request. The context size is what the request
 * sent: uncached input plus what the cache served plus what it wrote.
 */
export function exactUsageRecord(source: RecordSource, at: number, request: RequestUsage): TwoSystemsEvent & { type: "usage" } {
  const usage: Usage = { source: "exact" };
  if (request.requestId !== undefined && isToken(request.requestId)) usage.request_id = request.requestId;
  if (request.model !== undefined && isToken(request.model)) usage.model = request.model;
  const input = count(request.inputTokens);
  const output = count(request.outputTokens);
  const read = count(request.cacheReadTokens);
  const write = count(request.cacheWriteTokens);
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (read !== undefined) usage.cache_read_tokens = read;
  if (write !== undefined) usage.cache_write_tokens = write;
  if (input !== undefined || read !== undefined || write !== undefined) usage.context_tokens = (input ?? 0) + (read ?? 0) + (write ?? 0);
  if (request.costUsd !== undefined && Number.isFinite(request.costUsd) && request.costUsd >= 0) usage.cost_usd = request.costUsd;
  return { ...base(source, at), type: "usage", usage };
}

/** What the user did with a suggestion. */
export function userActionRecord(
  source: RecordSource,
  at: number,
  decisionId: string,
  action: UserActionKind,
): TwoSystemsEvent & { type: "user_action" } {
  return { ...base(source, at), type: "user_action", user_action: { decision_id: decisionId, action } };
}
