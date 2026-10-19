// The two typed questions twosystems asks a decision model.
// Thresholds in decisions.lock are fitted on one exact wording, recorded as a
// hash; changing a word here means fitting again.
// Part of twosystems, created by Shashikant.
import { createHash } from "node:crypto";
import type { DecisionName, Suggestion } from "./contracts.js";

export interface DecisionQuestion {
  name: DecisionName;
  /** Question type in the decisions API. Both questions are a choice between labels. */
  type: "choice";
  instructions: string;
  /** One plain sentence per label. Keys are the labels, in a fixed order. */
  criteria: Record<string, string>;
}

export const QUESTIONS: Record<DecisionName, DecisionQuestion> = {
  stuck: {
    name: "stuck",
    type: "choice",
    instructions:
      "An AI coding agent is working on a task. Judging only by its recent actions, is it making progress, or is it stuck repeating an approach that keeps failing?",
    criteria: {
      progressing: "Its recent actions change files, try different approaches or get further than before.",
      stuck: "It repeats the same commands or edits, meets the same error again and again, and nothing improves.",
    },
  },
  fresh_start: {
    name: "fresh_start",
    type: "choice",
    instructions:
      "A developer is about to send a new prompt to an AI coding agent. Given the session so far and the new prompt, what is the best way to continue?",
    criteria: {
      continue: "The new prompt continues the same task and the earlier conversation is still useful.",
      compact: "The same task continues, but the conversation is long and mostly old detail, so a short summary would keep what matters.",
      clear: "The new prompt starts a different task, so the earlier conversation is not needed.",
    },
  },
};

/** The suggestion shown for each label that can trigger one. Other labels mean "carry on". */
export const LABEL_SUGGESTION: Readonly<Record<string, Suggestion>> = {
  stuck: "pause",
  compact: "compact",
  clear: "clear",
};

/** Labels of a question, in order. */
export function labelsOf(question: DecisionQuestion): string[] {
  return Object.keys(question.criteria);
}

/** "sha256:" plus the hex digest of the UTF-8 text. */
export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Hash of the exact wording, as stored in decisions.lock under question_hash. */
export function questionHash(question: DecisionQuestion): string {
  return sha256(
    JSON.stringify({ type: question.type, instructions: question.instructions, criteria: question.criteria }),
  );
}
