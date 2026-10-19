// The receipt as plain text, for the twosystems command and the Claude Code plugin.
// Part of twosystems, created by Shashikant.
import type { Receipt } from "./receipt.js";

export function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(2)}`;
}

/** The receipt as plain text. */
export function formatReceipt(r: Receipt, days: number | undefined): string {
  const lines: string[] = [];
  lines.push(`twosystems receipt${days === undefined ? "" : ` (last ${days} days)`}`);
  lines.push(`Sessions watched:        ${r.sessions}`);
  lines.push(
    `Checks run:              ${r.decisions.total} (act ${r.decisions.byBand.act}, unsure ${r.decisions.byBand.unsure}, silent ${r.decisions.byBand.silent}, not evaluated ${r.decisions.byBand.not_evaluated})`,
  );
  const missed = r.decisions.notShown > 0 ? `; due but not shown in time: ${r.decisions.notShown}` : "";
  lines.push(`Suggestions shown:       ${r.decisions.shown} (held back on purpose: ${r.decisions.heldOut}${missed})`);
  lines.push(`Taken / declined:        ${r.actions.accepted} / ${r.actions.declined}`);
  lines.push(`Our own cost:            ${money(r.ownCostUsd)}`);
  lines.push(`Estimated tokens saved:  ${r.estimatedTokensSaved.toLocaleString("en-US")} (an estimate, not a measurement)`);
  const v = r.verified;
  if (v.status === "not_enough_data") {
    lines.push(`Verified saving:         not enough data yet (${v.shown} chosen to show and ${v.heldOut} held back; ${v.needed} of each needed)`);
  } else {
    const fmt = (x: number) => (v.unit === "usd" ? money(x) : `${Math.round(x).toLocaleString("en-US")} tokens`);
    const range = `${fmt(v.perMoment.low)} to ${fmt(v.perMoment.high)}`;
    lines.push(
      v.status === "verified"
        ? `Verified saving:         ${fmt(v.perMoment.mean)} per suggestion chosen to show (95% interval ${range})`
        : `Verified saving:         no clear effect yet (95% interval ${range} per suggestion chosen to show)`,
    );
  }
  return lines.join("\n");
}
