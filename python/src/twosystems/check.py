"""Checking a decisions.lock against labelled moments after they were scored again.

Run `twosystems moments --rescore --labelled-only` first: it asks the decision model
about every labelled moment once more and adds the answers. The check then fails on
any of these, for each decision in the lock:

- the question wording changed since the fit;
- the model version changed;
- the answers drifted: the mean change in probability between each moment's last
  two scorings by the lock's engine is above the limit, or too many moments change
  band between them (so run --rescore once per check, not twice);
- with the newest answers, the lock acts wrongly more often than its target.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .fit import copy_key
from .moments import Moment, engine_key, engine_name
from .stats import upper_bound
from .thresholds import SUGGESTION_LABEL, apply_thresholds


@dataclass
class DecisionCheck:
    decision: str
    lines: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)


def _scores(moment: Moment, key: tuple[str, str]) -> list[dict[str, Any]]:
    return sorted(
        (s for s in moment["scores"] if engine_key(s["engine"]) == key), key=lambda s: s["at"]
    )


def check_decision(
    name: str,
    entry: dict[str, Any],
    moments: list[Moment],
    *,
    max_drift: float,
    max_band_changes: float,
    confidence: float,
) -> DecisionCheck:
    result = DecisionCheck(name)
    key = engine_key(entry["engine"])
    labelled = []
    seen: set[tuple[str, str, str, str]] = set()
    for m in sorted(moments, key=lambda m: (m["session"], m["at"], m["id"])):
        # Copies of one moment from a forked or resumed session count once.
        if m["decision"] == name and "label" in m and copy_key(m) not in seen:
            seen.add(copy_key(m))
            labelled.append(m)
    current = [m for m in labelled if m["question_hash"] == entry["question_hash"]]
    if labelled and not current:
        result.failures.append("the question wording changed since the fit; label and fit again")
        return result
    scored = [(m, _scores(m, key)) for m in current]
    scored = [(m, s) for m, s in scored if s]
    if not scored:
        result.failures.append(f"no labelled moment has a score from {engine_name(key)}")
        return result
    result.lines.append(f"{len(scored)} labelled moment(s) scored by {engine_name(key)}")

    locked = entry["engine"].get("model_version")
    newest_versions = sorted({s[-1]["engine"].get("model_version", "") for _, s in scored} - {""})
    changed = [v for v in newest_versions if locked and v != locked]
    if changed:
        result.failures.append(
            f"model version changed: fitted on {locked}, now {', '.join(changed)}"
        )

    pairs = [(s[-2], s[-1]) for _, s in scored if len(s) >= 2]
    if pairs:
        labels = entry["labels"]
        diffs = [
            sum(
                abs(new["probabilities"].get(label, 0) - old["probabilities"].get(label, 0))
                for label in labels
            )
            / len(labels)
            for old, new in pairs
        ]
        mean = sum(diffs) / len(diffs)
        flips = sum(
            apply_thresholds(old["probabilities"], entry["thresholds"])
            != apply_thresholds(new["probabilities"], entry["thresholds"])
            for old, new in pairs
        )
        share = flips / len(pairs)
        result.lines.append(
            f"drift over {len(pairs)} rescored moment(s): mean change {mean:.3f}, "
            f"band changed for {flips} ({share:.0%})"
        )
        if mean > max_drift:
            result.failures.append(
                f"probabilities drifted: mean change {mean:.3f} is above {max_drift:g}"
            )
        if share > max_band_changes:
            result.failures.append(
                f"{share:.0%} of moments changed band, above {max_band_changes:.0%}"
            )
    else:
        result.lines.append("no moment has been scored twice yet, so drift was not checked")

    acts = false = 0
    for m, s in scored:
        band = apply_thresholds(s[-1]["probabilities"], entry["thresholds"])
        if band["band"] != "act":
            continue
        acts += 1
        if SUGGESTION_LABEL[band["suggestion"]] != m["label"]:
            false += 1
    target = entry["target_false_alarm"]
    if acts:
        rate = false / acts
        bound = upper_bound(false, acts, confidence)
        result.lines.append(
            f"with the newest answers: acts on {acts}, wrongly {false} "
            f"({rate:.1%}; upper bound {bound:.1%})"
        )
        if rate > target:
            result.failures.append(f"false alarms {rate:.1%} are above the target {target:.1%}")
    else:
        result.lines.append("with the newest answers it would not act on any labelled moment")
    return result


def check_lock(
    lock: dict[str, Any],
    moments: list[Moment],
    *,
    max_drift: float = 0.05,
    max_band_changes: float = 0.10,
    confidence: float = 0.95,
) -> list[DecisionCheck]:
    return [
        check_decision(
            name,
            entry,
            moments,
            max_drift=max_drift,
            max_band_changes=max_band_changes,
            confidence=confidence,
        )
        for name, entry in lock["decisions"].items()
    ]
