"""Fitting thresholds on labelled moments, with an upper bound on false alarms.

For each decision there is one act threshold, shared by the labels that lead to a
suggestion. It is chosen by fixed-sequence testing (Learn then Test): thresholds are
tried from 1.00 down in steps of 0.01, and each is accepted only while the one-sided
Clopper-Pearson upper bound on its false-alarm rate (acting when the person's label
was something else) stays at or below the target. The first threshold that fails
ends the descent. Of the accepted thresholds, the one kept acts on the most fitting
moments, and among those acting on the same moments it is the highest. Because the
thresholds are tried in a fixed order and the search stops at the first failure,
the chance that any accepted threshold's real false-alarm rate is above the target
is at most one minus the confidence, however many thresholds were tried.
Thresholds that act on fewer moments than the bound could ever accept are skipped
before the descent starts; which ones those are depends only on the scores, not on
the labels, so skipping them keeps the guarantee.

The guarantee assumes the labelled moments are independent draws from the moments
twosystems will meet. Moments from one session are alike, which makes the bound a
little optimistic; labelling takes one moment from each session in turn to spread
the labels, and a share of sessions is kept out of fitting to test on.

The unsure threshold is the lowest at which, among moments that would be shown as
unsure (at or above it and below the act threshold), the suggested label is right
at least half the time.

The probabilities are used as the engine gives them (calibration "none"): for a
threshold rule this loses nothing, because any calibration that keeps the order of
probabilities would only move the thresholds.

Sessions are split into a fitting part and a test part by a hash of the session
id, so the split is the same every time and moments of one session never land on
both sides. Same input, same output: there is no randomness and no clock.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .moments import Moment, engine_key, engine_name, newest_score
from .stats import fewest_tries, upper_bound
from .thresholds import SUGGESTION_LABEL, action_labels, apply_thresholds

#: Thresholds tried for each action label: 0.50, 0.51, ... 0.99, 1.00.
GRID = [round(0.5 + i / 100, 2) for i in range(51)]
DECISIONS = ("stuck", "fresh_start")


def is_test_session(session: str, test_share: float) -> bool:
    """True for sessions kept out of fitting to test the thresholds on."""
    digest = hashlib.sha256(f"twosystems-split\n{session}".encode()).hexdigest()
    return int(digest[:8], 16) / 2**32 < test_share


@dataclass
class Example:
    """A labelled moment with the score the fit uses."""

    moment: Moment
    label: str
    probabilities: dict[str, float]
    model_version: str | None


@dataclass
class Outcome:
    """What thresholds do on a set of labelled moments."""

    moments: int
    acts: int
    false_alarms: int

    @property
    def correct(self) -> int:
        return self.acts - self.false_alarms

    def rate(self) -> float | None:
        return self.false_alarms / self.acts if self.acts else None


def outcome(examples: list[Example], thresholds: dict[str, dict[str, float]]) -> Outcome:
    acts = false = 0
    for example in examples:
        result = apply_thresholds(example.probabilities, thresholds)
        if result["band"] != "act":
            continue
        acts += 1
        if SUGGESTION_LABEL[result["suggestion"]] != example.label:
            false += 1
    return Outcome(moments=len(examples), acts=acts, false_alarms=false)


@dataclass
class Step:
    """One threshold tried in the descent, on the fitting part."""

    threshold: float
    acts: int
    false_alarms: int
    upper: float

    def passed(self, target: float) -> bool:
        return self.upper <= target


@dataclass
class DecisionFit:
    decision: str
    engine: tuple[str, str]
    question_hash: str | None = None
    labels: list[str] = field(default_factory=list)
    train: list[Example] = field(default_factory=list)
    test: list[Example] = field(default_factory=list)
    excluded: Counter[str] = field(default_factory=Counter)
    thresholds: dict[str, dict[str, float]] | None = None
    train_outcome: Outcome | None = None
    test_outcome: Outcome | None = None
    upper: float | None = None
    test_upper: float | None = None
    steps: list[Step] = field(default_factory=list)
    problem: str | None = None
    model_version: str | None = None

    def lock_entry(self, target: float, confidence: float) -> dict[str, Any]:
        assert (
            self.thresholds is not None
            and self.train_outcome is not None
            and self.upper is not None
        )
        engine: dict[str, Any] = {"kind": self.engine[0]}
        if self.engine[1]:
            engine["model"] = self.engine[1]
        if self.model_version:
            engine["model_version"] = self.model_version
        return {
            "engine": engine,
            "question_hash": self.question_hash,
            "labels": self.labels,
            "calibration": {"method": "none"},
            "thresholds": self.thresholds,
            "target_false_alarm": target,
            "fitted_on": {
                "n": len(self.train),
                "false_alarm_upper": round(self.upper, 4),
                "coverage": round(self.train_outcome.acts / len(self.train), 4),
                "confidence": confidence,
            },
        }


def pick_engine(moments: list[Moment], decision: str) -> tuple[str, str] | None:
    """The engine to fit for: the decision model that scored most labelled moments, else rules."""
    counts: Counter[tuple[str, str]] = Counter()
    for m in moments:
        if m["decision"] != decision or "label" not in m:
            continue
        for key in {engine_key(s["engine"]) for s in m["scores"]}:
            counts[key] += 1
    models = [(n, key) for key, n in counts.items() if key[0] != "rules"]
    if models:
        return max(models, key=lambda item: (item[0], item[1]))[1]
    return ("rules", "") if counts else None


def current_question(moments: list[Moment], decision: str) -> str | None:
    """The question wording the newest export used: the hash on the latest moment."""
    of_decision = [m for m in moments if m["decision"] == decision]
    if not of_decision:
        return None
    return max(of_decision, key=lambda m: (m["at"], m["id"]))["question_hash"]


def copy_key(moment: Moment) -> tuple[str, str, str, str]:
    """Copies of one moment found in a forked or resumed session share this key."""
    return (moment["decision"], moment.get("trigger", ""), moment["at"], moment["state"]["hash"])


def gather(
    moments: list[Moment], decision: str, engine: tuple[str, str], test_share: float
) -> DecisionFit:
    """The labelled moments to fit on and to test on, each with one score.

    Every score used comes from the same engine and the same model version: the
    version of the newest score, which is the model running now. Moments scored only
    by an older version are left out (`twosystems moments --rescore --labelled-only`
    scores them again), because a lock fitted on two models' answers fits neither.
    Copies of one moment from a forked or resumed session count once.
    """
    fit = DecisionFit(decision=decision, engine=engine)
    fit.question_hash = current_question(moments, decision)
    eligible: list[Moment] = []
    for m in sorted(moments, key=lambda m: (m["session"], m["at"], m["id"])):
        if m["decision"] != decision:
            continue
        if "label" not in m:
            fit.excluded["not labelled"] += 1
        elif m["question_hash"] != fit.question_hash:
            fit.excluded["built for an older question"] += 1
        elif newest_score(m, engine) is None:
            fit.excluded[f"not scored by {engine_name(engine)}"] += 1
        else:
            eligible.append(m)
    if not eligible:
        return fit
    newest = max((newest_score(m, engine) for m in eligible), key=lambda s: s["at"] if s else "")
    version = newest["engine"].get("model_version") if newest else None
    fit.model_version = version
    seen: set[tuple[str, str, str, str]] = set()
    for m in eligible:
        scores = [
            s
            for s in m["scores"]
            if engine_key(s["engine"]) == engine and s["engine"].get("model_version") == version
        ]
        if not scores:
            fit.excluded["scored only by an older model version"] += 1
            continue
        if copy_key(m) in seen:
            fit.excluded["a copy from a forked or resumed session"] += 1
            continue
        seen.add(copy_key(m))
        score = max(scores, key=lambda s: s["at"])
        fit.labels = m["labels"]
        example = Example(m, m["label"], score["probabilities"], version)
        (fit.test if is_test_session(m["session"], test_share) else fit.train).append(example)
    return fit


def _top(example: Example, actions: list[str]) -> tuple[str, float]:
    """The action label a shared threshold would act on first, and its probability."""
    label = min(actions, key=lambda a: (-example.probabilities.get(a, 0), a))
    return label, example.probabilities.get(label, 0)


def descend(
    examples: list[Example], actions: list[str], target: float, confidence: float
) -> tuple[Step | None, list[Step]]:
    """Fixed-sequence testing from 1.00 down: the threshold kept, or None, and every
    threshold tried.

    Every threshold accepted before the first failure keeps the guarantee; the one kept
    acts on the most fitting moments, and among those that act on the same moments it
    is the highest, so the lock never reaches below the scores the labels cover.
    """
    need = fewest_tries(target, confidence)
    steps: list[Step] = []
    for t in reversed(GRID):
        result = outcome(examples, {label: {"act": t, "unsure": t} for label in actions})
        if result.acts < need:
            # Too few acts for the bound ever to pass; decided by the scores alone.
            continue
        bound = upper_bound(result.false_alarms, result.acts, confidence)
        steps.append(Step(t, result.acts, result.false_alarms, bound))
        if bound > target:
            break
    accepted = [step for step in steps if step.passed(target)]
    if not accepted:
        return None, steps
    most = accepted[-1].acts
    return next(step for step in accepted if step.acts == most), steps


def _unsure(examples: list[Example], actions: list[str], act: float) -> float:
    """Lowest threshold below act where moments shown as unsure get the label right
    at least half the time; act itself (no unsure band) when there is none."""
    tops = [(_top(e, actions), e.label) for e in examples]
    for t in GRID:
        if t >= act:
            break
        band = [(label, truth) for (label, p), truth in tops if t <= p < act]
        if band and sum(label == truth for label, truth in band) * 2 >= len(band):
            return t
    return act


def fit_decision(
    moments: list[Moment],
    decision: str,
    *,
    target: float,
    confidence: float,
    test_share: float,
    engine: tuple[str, str] | None = None,
) -> DecisionFit:
    chosen = engine or pick_engine(moments, decision)
    if chosen is None:
        fit = DecisionFit(decision=decision, engine=("rules", ""))
        fit.problem = "no labelled moments"
        return fit
    fit = gather(moments, decision, chosen, test_share)
    actions = action_labels(fit.labels)
    if not fit.train:
        fit.problem = "no labelled moments to fit on"
        return fit
    kept, fit.steps = descend(fit.train, actions, target, confidence)
    need = fewest_tries(target, confidence)
    if kept is None:
        if not fit.steps:
            fit.problem = (
                f"no threshold acts on {need} or more of the moments to fit on, which the bound "
                f"needs at a {target:g} target even with no false alarms: label more moments, "
                "or allow a higher target"
            )
        else:
            first = fit.steps[0]
            fit.problem = (
                f"the first threshold with enough acts ({first.threshold:.2f}: {first.acts} acts, "
                f"{first.false_alarms} wrong) has a false-alarm bound of {first.upper:.1%}, "
                f"above the {target:g} target: label more moments, or allow a higher target"
            )
        return fit
    act = kept.threshold
    fit.upper = kept.upper
    fit.train_outcome = Outcome(
        moments=len(fit.train), acts=kept.acts, false_alarms=kept.false_alarms
    )
    unsure = _unsure(fit.train, actions, act)
    fit.thresholds = {label: {"act": act, "unsure": unsure} for label in actions}
    if fit.test:
        fit.test_outcome = outcome(fit.test, fit.thresholds)
        if fit.test_outcome.acts > 0:
            fit.test_upper = upper_bound(
                fit.test_outcome.false_alarms, fit.test_outcome.acts, confidence
            )
    return fit


def build_lock(
    fits: list[DecisionFit],
    *,
    target: float,
    confidence: float,
    holdout_rate: float,
    created_by: str,
) -> dict[str, Any] | None:
    """A decisions.lock with every decision that could be fitted, or None when none could.

    created_at is the time of the newest label used, so the same labels always give
    the same file.
    """
    entries = {
        f.decision: f.lock_entry(target, confidence) for f in fits if f.thresholds is not None
    }
    if not entries:
        return None
    labelled_at = [
        e.moment["labelled_at"] for f in fits if f.thresholds is not None for e in f.train + f.test
    ]
    return {
        "lock_version": 1,
        "created_at": max(labelled_at),
        "created_by": created_by,
        "holdout_rate": holdout_rate,
        "decisions": entries,
    }
