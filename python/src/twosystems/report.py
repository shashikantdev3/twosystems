"""An HTML report of labelled moments, thresholds and what twosystems did.

One self-contained page with no scripts and nothing fetched from the internet,
so it can be opened anywhere and shared as a file.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

import json
from collections import Counter
from html import escape
from pathlib import Path
from typing import Any

from . import __version__
from .contracts import validate_event
from .label import label_counts
from .moments import Moment, engine_key, engine_name, newest_score
from .stats import upper_bound
from .thresholds import LABEL_SUGGESTION, SUGGESTION_LABEL, action_labels, apply_thresholds

STEPS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]

STYLE = """
:root {
  --bg: #ffffff; --fg: #1d2330; --muted: #5d6576; --line: #dfe3ea;
  --head: #f3f5f8; --bad: #b3261e; --good: #1b6e3a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c; --fg: #e6e9ef; --muted: #a2a9b6; --line: #2b313b;
    --head: #1c2027; --bad: #ff8a80; --good: #7bd88f;
  }
}
body {
  background: var(--bg); color: var(--fg); margin: 0;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 32px 0 8px; }
h3 { font-size: 16px; margin: 20px 0 6px; }
.muted { color: var(--muted); }
table {
  border-collapse: collapse; width: 100%; margin: 8px 0 16px;
  font-variant-numeric: tabular-nums;
}
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; }
th { background: var(--head); font-weight: 600; }
td.num, th.num { text-align: right; }
.bad { color: var(--bad); font-weight: 600; }
.good { color: var(--good); font-weight: 600; }
.wrap { overflow-x: auto; }
"""


def _cell(tag: str, text: str, numeric: bool) -> str:
    return f'<{tag} class="{"num" if numeric else ""}">{text}</{tag}>'


def _table(head: list[str], rows: list[list[str]], numeric: set[int] | None = None) -> str:
    numeric = numeric or set()
    cells = "".join(_cell("th", escape(h), i in numeric) for i, h in enumerate(head))
    body = "".join(
        "<tr>" + "".join(_cell("td", c, i in numeric) for i, c in enumerate(row)) + "</tr>"
        for row in rows
    )
    return (
        f'<div class="wrap"><table><thead><tr>{cells}</tr></thead>'
        f"<tbody>{body}</tbody></table></div>"
    )


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value:.1%}"


def read_events(home: Path) -> tuple[list[dict[str, Any]], int]:
    """Events from events.jsonl and every file in events.d, each counted once.

    Also returns how many lines could not be read.
    """
    events: dict[str, dict[str, Any]] = {}
    skipped = 0
    files = [home / "events.jsonl", *sorted((home / "events.d").glob("*.jsonl"))]
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for raw in text.removeprefix("\ufeff").split("\n"):
            line = raw.removesuffix("\r")
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError:
                skipped += 1
                continue
            if not validate_event(value).ok:
                skipped += 1
                continue
            events.setdefault(value["id"], value)
    return list(events.values()), skipped


def _engines(mine: list[Moment]) -> Counter[tuple[str, str]]:
    engines: Counter[tuple[str, str]] = Counter()
    for m in mine:
        for key in {engine_key(s["engine"]) for s in m["scores"]}:
            engines[key] += 1
    return engines


def _threshold_table(
    labels: list[str], labelled: list[tuple[Moment, dict[str, Any]]], confidence: float
) -> list[str]:
    """What one act threshold, shared by the labels that lead to a suggestion, would do."""
    actions = action_labels(labels)
    rows = []
    for t in STEPS:
        thresholds = {label: {"act": t, "unsure": t} for label in actions}
        acts = wrong = 0
        for m, s in labelled:
            band = apply_thresholds(s["probabilities"], thresholds)
            if band["band"] == "act":
                acts += 1
                wrong += SUGGESTION_LABEL[band["suggestion"]] != m["label"]
        rate = wrong / acts if acts else None
        bound = upper_bound(wrong, acts, confidence) if acts else None
        rows.append([f"{t:.2f}", str(acts), str(wrong), _pct(rate), _pct(bound)])
    suggests = ", ".join(f"{escape(a)} suggests {escape(LABEL_SUGGESTION[a])}" for a in actions)
    head = ["Act at", "Would act", "Wrong", "False-alarm rate", "Upper bound"]
    return [f"<p>{suggests}.</p>", _table(head, rows, {0, 1, 2, 3, 4})]


def _lock_part(entry: dict[str, Any], labelled: list[tuple[Moment, dict[str, Any]]]) -> list[str]:
    parts = ["<h3>The fitted thresholds</h3>"]
    rows = [
        [escape(label), f"{t['act']:.2f}", f"{t['unsure']:.2f}"]
        for label, t in entry["thresholds"].items()
    ]
    parts.append(_table(["Label", "Act at", "Unsure at"], rows, {1, 2}))
    fitted = entry.get("fitted_on")
    target = entry["target_false_alarm"]
    if fitted:
        parts.append(
            f"<p>Fitted on {fitted['n']} labelled moments; acts on "
            f"{fitted.get('coverage', 0):.1%} of them; false-alarm upper bound "
            f"{fitted['false_alarm_upper']:.1%} at {fitted['confidence']:.0%} confidence; "
            f"target {target:.1%}.</p>"
        )
    acts = wrong = 0
    for m, s in labelled:
        band = apply_thresholds(s["probabilities"], entry["thresholds"])
        if band["band"] == "act":
            acts += 1
            wrong += SUGGESTION_LABEL[band["suggestion"]] != m["label"]
    if not acts:
        verdict = "no acts"
    elif wrong / acts <= target:
        verdict = '<span class="good">within the target</span>'
    else:
        verdict = '<span class="bad">above the target</span>'
    rate = _pct(wrong / acts if acts else None)
    parts.append(
        f"<p>On all {len(labelled)} labelled moments with the newest scores: "
        f"acts on {acts}, wrongly {wrong} ({rate}), {verdict}.</p>"
    )
    return parts


def _decision_section(
    name: str, moments: list[Moment], entry: dict[str, Any] | None, confidence: float
) -> str:
    parts = [f"<h2>{escape(name)}</h2>"]
    mine = [m for m in moments if m["decision"] == name]
    empty = {"moments": 0, "labelled": 0, "labels": {}}
    summary = label_counts(mine).get(name, empty)
    labels = mine[0]["labels"] if mine else []
    rows = [["Moments found", str(summary["moments"])], ["Labelled", str(summary["labelled"])]]
    rows += [[f"Labelled {escape(lb)}", str(summary["labels"].get(lb, 0))] for lb in labels]
    parts.append(_table(["", "Count"], rows, {1}))
    if not mine:
        return "".join(parts)

    engines = _engines(mine)
    parts.append("<h3>Engines that scored these moments</h3>")
    rows = [[escape(engine_name(k)), str(n)] for k, n in engines.most_common()]
    if engines:
        parts.append(_table(["Engine", "Moments scored"], rows, {1}))

    if entry is not None:
        key = engine_key(entry["engine"])
    elif engines:
        key = max(engines.items(), key=lambda kv: (kv[0][0] != "rules", kv[1]))[0]
    else:
        parts.append(
            '<p class="muted">No moment has a score yet. Run <code>twosystems moments</code> '
            "to add the free rules scores.</p>"
        )
        return "".join(parts)
    scored = [(m, newest_score(m, key)) for m in mine if "label" in m]
    labelled = [(m, s) for m, s in scored if s is not None]
    parts.append(f"<h3>What each act threshold would do, {escape(engine_name(key))}</h3>")
    parts.append(
        '<p class="muted">On the labelled moments: how often one act threshold, shared by '
        "the labels that lead to a suggestion, would act, how often that was wrong, and the "
        f"{confidence:.0%} upper bound on the false-alarm rate. The fit tests these from the "
        "top down, stops at the first failure, and keeps the accepted one that acts on the "
        "most moments (the highest, when several act on the same moments).</p>"
    )
    parts.extend(_threshold_table(labels, labelled, confidence))
    if entry is not None:
        parts.extend(_lock_part(entry, labelled))
    return "".join(parts)


def _events_section(events: list[dict[str, Any]], skipped: int) -> str:
    decisions = [e for e in events if e["type"] == "decision"]
    actions = [e for e in events if e["type"] == "user_action"]
    parts = ["<h2>What twosystems did</h2>"]
    if not events:
        parts.append('<p class="muted">The event log is empty so far.</p>')
        return "".join(parts)
    by: Counter[tuple[str, str]] = Counter(
        (d["decision"]["name"], d["decision"]["band"]) for d in decisions
    )
    rows = [[escape(n), escape(b), str(c)] for (n, b), c in sorted(by.items())]
    parts.append(_table(["Decision", "Band", "Count"], rows, {2}))
    held = sum(1 for d in decisions if d["decision"].get("holdout"))
    cost = sum(d["decision"].get("cost_usd", 0) for d in decisions)
    taken: Counter[str] = Counter(a["user_action"]["action"] for a in actions)
    answers = ", ".join(f"{k} {v}" for k, v in sorted(taken.items())) or "none yet"
    parts.append(
        f"<p>Held back on purpose: {held}. Decision model cost: ${cost:.5f}. "
        f"User answers: {escape(answers)}.</p>"
    )
    parts.append(
        '<p class="muted">For the token savings, with the estimate and the verified figure '
        "kept apart, run <code>twosystems receipt</code>.</p>"
    )
    if skipped:
        parts.append(
            f'<p class="muted">{skipped} line(s) of the event log could not be read '
            "and were skipped.</p>"
        )
    return "".join(parts)


def build_report(
    moments: list[Moment],
    lock: dict[str, Any] | None,
    events: list[dict[str, Any]],
    skipped: int,
    *,
    generated: str,
    confidence: float = 0.95,
) -> str:
    entries = (lock or {}).get("decisions", {})
    sections = [
        _decision_section(name, moments, entries.get(name), confidence)
        for name in ("stuck", "fresh_start")
    ]
    if lock:
        lock_line = (
            f"Thresholds from decisions.lock, written {escape(lock['created_at'])} "
            f"by {escape(lock['created_by'])}."
        )
    else:
        lock_line = "No decisions.lock yet: twosystems uses its built-in thresholds."
    head = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>twosystems calibration report</title><style>{STYLE}</style></head>"
    )
    intro = (
        "<h1>twosystems calibration report</h1>"
        f'<p class="muted">Made {escape(generated)} by twosystems-calibrate '
        f"{escape(__version__)}. twosystems is created by Shashikant: "
        "https://github.com/shashikantdev3/twosystems</p>"
        f"<p>{lock_line}</p>"
    )
    body = intro + "".join(sections) + _events_section(events, skipped)
    return f"{head}<body><main>{body}</main></body></html>\n"
