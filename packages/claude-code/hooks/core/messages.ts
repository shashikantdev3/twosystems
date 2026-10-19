// What twosystems says to the user, shared by every adapter.
// Part of twosystems, created by Shashikant.
import type { Agent } from "./model.js";
import type { SignalName } from "./signals.js";

export const SIGNAL_TEXT: Record<SignalName, string> = {
  repeated_command: "the same command keeps failing",
  repeated_error: "the same error keeps coming back",
  no_file_change: "no file has changed for a while",
  many_tool_calls: "many steps without a new prompt",
  large_context: "the conversation is large",
  cache_expired: "the prompt cache has probably expired",
  new_prompt_low_overlap: "the new prompt looks like a different task",
};

export function describe(signals: readonly SignalName[]): string {
  return signals.map((s) => SIGNAL_TEXT[s]).join("; ");
}

export function thousands(tokens: number): string {
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
