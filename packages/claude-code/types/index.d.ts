// The values twosystems keeps in Claude Code's session state, read while the
// band above the prompt is drawn. Part of twosystems, created by Shashikant.

/** A fresh-start suggestion shown in the band above the prompt. */
export type TwosystemsBand = {
  /** The decision record this suggestion came from. */
  decisionId: string;
  /** The session the decision was recorded under. */
  session: string;
  /** What twosystems suggests. */
  suggestion: "clear" | "compact";
  /** One plain sentence saying why. */
  message: string;
  /** Size of the conversation when the suggestion was made, in tokens. */
  tokens: number;
  /** A prompt held back until the user chooses, when the suggestion came from it. */
  heldPrompt: string | null;
  /** When it was shown, in milliseconds since the epoch. */
  shownAt: number;
  /**
   * True when the user already answered the suggestion and only the held
   * prompt still waits here (the prompt box could not take it back), so a
   * press is not recorded as a second answer.
   */
  answered?: boolean;
};

declare module "claude-code" {
  interface PluginState {
    twosystems: { band: TwosystemsBand | null };
  }
}
