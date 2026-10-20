"""Tests for the calibration kit: moments files, thresholds, the bound, fit, check,
label and report.

Part of twosystems, created by Shashikant.
"""

from __future__ import annotations

import json
import os
import random
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from twosystems.check import check_lock
from twosystems.cli import main
from twosystems.contracts import validate_lock, validate_moment, validate_moment_text
from twosystems.fit import build_lock, descend, fit_decision, is_test_session
from twosystems.label import label_moments, labelling_order, question_for
from twosystems.moments import (
    LOCK_STALE_SECONDS,
    MomentsFileError,
    moments_lock,
    read_moments,
    save_label,
    write_moments,
)
from twosystems.report import build_report, read_events
from twosystems.stats import binomial_cdf, fewest_tries, upper_bound
from twosystems.thresholds import apply_thresholds

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "schemas" / "examples"
STUCK_Q = "sha256:" + "a" * 64
FRESH_Q = "sha256:" + "b" * 64
MODEL = {"kind": "openrouter", "model": "microsoft/microsoft-decision-1-20261009"}


def moment(
    i: int,
    *,
    decision: str = "stuck",
    label: str | None = None,
    p: float | dict[str, float] | None = None,
    session: str | None = None,
    version: str = "microsoft/microsoft-decision-1-20261009",
    question: str | None = None,
    extra_scores: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    labels = ["progressing", "stuck"] if decision == "stuck" else ["continue", "compact", "clear"]
    m: dict[str, Any] = {
        "v": 1,
        "id": f"m{i:06d}",
        "decision": decision,
        "agent": "claude-code",
        "session": session or f"session-{i % 40}",
        "at": f"2026-10-18T{(i // 3600) % 24:02d}:{(i // 60) % 60:02d}:{i % 60:02d}.000Z",
        "question_hash": question or (STUCK_Q if decision == "stuck" else FRESH_Q),
        "labels": labels,
        "signals": ["repeated_command"] if decision == "stuck" else ["large_context"],
        "state": {"lines": [f"moment {i}"], "hash": "sha256:" + "c" * 64},
        "after": ["Bash: npm test -> ok"],
        "scores": [],
    }
    if p is not None:
        probabilities = (
            p if isinstance(p, dict) else {"progressing": round(1 - p, 4), "stuck": round(p, 4)}
        )
        engine = {**MODEL, "model_version": version}
        m["scores"].append(
            {"engine": engine, "probabilities": probabilities, "at": "2026-10-19T08:00:00.000Z"}
        )
    m["scores"].extend(extra_scores or [])
    if label is not None:
        m["label"] = label
        m["labelled_at"] = f"2026-10-19T09:{(i // 60) % 60:02d}:{i % 60:02d}.000Z"
    return m


def stuck_set() -> list[dict[str, Any]]:
    """300 truly stuck moments the model is sure of, 150 progressing ones it mostly doubts,
    and twelve progressing ones it is wrongly sure of."""
    moments = [moment(i, label="stuck", p=0.95 + (i % 5) / 100) for i in range(300)]
    moments += [moment(300 + i, label="progressing", p=0.1 + (i % 70) / 100) for i in range(150)]
    moments += [moment(450 + i, label="progressing", p=0.97) for i in range(12)]
    return moments


# Files ---------------------------------------------------------------------


def test_the_shared_example_moments_pass_and_invalid_ones_give_the_same_messages() -> None:
    text = (EXAMPLES / "moments.example.jsonl").read_text("utf-8")
    lines = [line for line in text.split("\n") if line]
    assert len(lines) == 2
    for line in lines:
        assert validate_moment_text(line).errors == []
    cases = json.loads((EXAMPLES / "invalid-moments.json").read_text("utf-8"))
    assert len(cases) == 11
    for case in cases:
        result = validate_moment(case["moment"])
        assert not result.ok, case["why"]
        assert any(e.startswith(case["path"] + " ") for e in result.errors), case["why"]
        assert result.errors == case["errors"], case["why"]


def test_a_moments_file_round_trips_and_a_damaged_line_stops_the_read(tmp_path: Path) -> None:
    path = tmp_path / "moments.jsonl"
    with pytest.raises(MomentsFileError, match="does not exist yet"):
        read_moments(path)
    moments = [moment(1, label="stuck", p=0.9), moment(2)]
    write_moments(path, moments)
    assert read_moments(path) == moments
    if sys.platform != "win32":
        assert path.stat().st_mode & 0o777 == 0o600
    good = path.read_text("utf-8")
    path.write_text(good + '{"v": 1}\n', encoding="utf-8")
    with pytest.raises(MomentsFileError, match="line 3: <root> is missing the required field"):
        read_moments(path)
    # The same id twice is refused, naming both lines.
    path.write_text(good + good.split("\n")[0] + "\n", encoding="utf-8")
    with pytest.raises(MomentsFileError, match="line 3: the id m000001 is already used on line 1$"):
        read_moments(path)
    # A file that cannot be opened is explained, not a crash.
    with pytest.raises(MomentsFileError, match="could not be read"):
        read_moments(tmp_path)


def test_a_label_saved_while_moments_are_written_keeps_both(tmp_path: Path) -> None:
    path = tmp_path / "moments.jsonl"
    write_moments(path, [moment(1, p=0.9), moment(2, p=0.9)])
    # Another command added a moment after the labelling session read the file.
    write_moments(path, [*read_moments(path), moment(3, p=0.9)])
    save_label(path, "m000001", "stuck", "2026-10-20T10:00:00.000Z")
    stored = {m["id"]: m for m in read_moments(path)}
    assert set(stored) == {"m000001", "m000002", "m000003"}
    assert stored["m000001"]["label"] == "stuck"
    save_label(path, "m000001", None, None)
    assert "label" not in read_moments(path)[0]
    with pytest.raises(MomentsFileError, match="looping is not one of the labels"):
        save_label(path, "m000001", "looping", "2026-10-20T10:00:00.000Z")
    with pytest.raises(MomentsFileError, match="no longer holds moment m999999"):
        save_label(path, "m999999", "stuck", "2026-10-20T10:00:00.000Z")
    with pytest.raises(MomentsFileError, match="could not be saved: /labelled_at"):
        save_label(path, "m000001", "stuck", "yesterday")
    assert "label" not in read_moments(path)[0]


def test_a_half_character_from_typescript_can_be_saved_again(tmp_path: Path) -> None:
    # Node writes an unpaired surrogate as an escape; Python reads it as a lone surrogate.
    path = tmp_path / "moments.jsonl"
    m = moment(1, p=0.9)
    m["state"]["lines"] = ["Latest prompt: fix this \\ud83d"]
    path.write_text(json.dumps(m).replace("\\\\ud83d", "\\ud83d") + "\n", encoding="utf-8")
    [read] = read_moments(path)
    assert read["state"]["lines"][0].endswith("\ud83d")
    save_label(path, "m000001", "stuck", "2026-10-20T10:00:00.000Z")
    text = path.read_text("utf-8")
    assert "\\ud83d" in text
    assert read_moments(path)[0]["label"] == "stuck"
    # Other text stays readable, not escaped.
    m2 = moment(2, p=0.9)
    m2["state"]["lines"] = ["Latest prompt: café 😀"]
    write_moments(path, [m2])
    assert "café 😀" in path.read_text("utf-8")


def test_a_moment_dropped_meanwhile_is_skipped_not_fatal(tmp_path: Path) -> None:
    path = tmp_path / "moments.jsonl"
    moments = [moment(1, p=0.9), moment(2, p=0.9)]
    write_moments(path, moments[1:])
    said: list[str] = []
    answers = iter(["s", "s", "q"])
    counts = label_moments(
        moments,
        path,
        ask=lambda _: next(answers),
        say=said.append,
        clock=lambda: "2026-10-20T10:00:00.000Z",
    )
    assert counts["skipped"] + counts["labelled"] == 2
    assert any("no longer in the file" in line for line in said)


def test_writers_wait_for_the_lock_and_a_crashed_lock_is_taken_over(tmp_path: Path) -> None:
    path = tmp_path / "moments.jsonl"
    write_moments(path, [moment(i, p=0.9) for i in range(8)])
    errors: list[BaseException] = []

    def label(i: int) -> None:
        try:
            save_label(path, f"m{i:06d}", "stuck", "2026-10-20T10:00:00.000Z")
        except BaseException as error:  # pragma: no cover - reported below
            errors.append(error)

    threads = [threading.Thread(target=label, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert all(m.get("label") == "stuck" for m in read_moments(path))

    lock = tmp_path / "moments.jsonl.lock"
    lock.write_text("12345 crashed\n", encoding="utf-8")
    old = time.time() - LOCK_STALE_SECONDS - 60
    os.utime(lock, (old, old))
    save_label(path, "m000001", None, None)
    assert not lock.exists()

    # The lock is removed afterwards only if it is still this command's own.
    with moments_lock(path):
        lock.write_text("someone else\n", encoding="utf-8")
    assert lock.read_text("utf-8") == "someone else\n"
    lock.unlink()

    # A lock in use is waited for, then reported with how to clear it.
    lock.write_text("12345 busy\n", encoding="utf-8")
    clock = iter(float(t) for t in range(time.time().__int__(), time.time().__int__() + 1000, 6))
    with pytest.raises(MomentsFileError, match="delete .*moments.jsonl.lock"):
        with moments_lock(path, clock=lambda: next(clock), sleep=lambda _: None):
            pass
    assert lock.read_text("utf-8") == "12345 busy\n"


def test_the_shared_threshold_cases_give_the_same_band_as_typescript() -> None:
    cases = json.loads((EXAMPLES / "threshold-cases.json").read_text("utf-8"))
    assert len(cases) == 15
    for case in cases:
        assert apply_thresholds(case["probabilities"], case["thresholds"]) == case["expected"], (
            case["why"]
        )


# Statistics ----------------------------------------------------------------


def test_the_upper_bound_matches_known_values() -> None:
    assert upper_bound(0, 59) == pytest.approx(0.0495, abs=1e-4)
    assert upper_bound(0, 58) > 0.05
    assert upper_bound(1, 100) == pytest.approx(0.0466, abs=1e-4)
    assert upper_bound(5, 5) == 1.0
    assert upper_bound(0, 0) == 1.0
    assert fewest_tries(0.05) == 59
    assert fewest_tries(0.10) == 29
    assert binomial_cdf(2, 10, 0.3) == pytest.approx(0.3828, abs=1e-4)
    assert binomial_cdf(10, 10, 0.3) == 1.0


# Fit -----------------------------------------------------------------------


def test_fit_picks_thresholds_that_keep_false_alarms_under_the_bound() -> None:
    moments = stuck_set()
    fit = fit_decision(moments, "stuck", target=0.05, confidence=0.95, test_share=0)
    assert fit.engine == ("openrouter", "microsoft/microsoft-decision-1-20261009")
    assert fit.thresholds is not None and fit.train_outcome is not None and fit.upper is not None
    assert fit.upper <= 0.05
    # The twelve wrongly sure moments sit at 0.97: acting from 0.95 would be wrong 12 times
    # in 312 (upper bound above 6%), so the fit acts from 0.98, which avoids them and still
    # acts on the most truly stuck moments (120, against 60 at 0.99).
    assert upper_bound(12, 312) > 0.05
    assert fit.thresholds["stuck"]["act"] == 0.98
    assert (fit.train_outcome.acts, fit.train_outcome.false_alarms) == (120, 0)
    assert fit.thresholds["stuck"]["unsure"] <= fit.thresholds["stuck"]["act"]
    assert fit.model_version == "microsoft/microsoft-decision-1-20261009"

    split = fit_decision(moments, "stuck", target=0.05, confidence=0.95, test_share=0.25)
    assert len(split.train) + len(split.test) == len(moments)
    assert split.test_outcome is not None


def test_fit_is_reproducible_and_writes_a_valid_lock() -> None:
    first = fit_decision(stuck_set(), "stuck", target=0.05, confidence=0.95, test_share=0.25)
    second = fit_decision(stuck_set(), "stuck", target=0.05, confidence=0.95, test_share=0.25)
    lock_a = build_lock([first], target=0.05, confidence=0.95, holdout_rate=0.1, created_by="t")
    lock_b = build_lock([second], target=0.05, confidence=0.95, holdout_rate=0.1, created_by="t")
    assert lock_a == lock_b
    assert lock_a is not None
    assert validate_lock(lock_a).errors == []
    entry = lock_a["decisions"]["stuck"]
    assert entry["question_hash"] == STUCK_Q
    assert entry["engine"]["model_version"] == "microsoft/microsoft-decision-1-20261009"
    assert entry["calibration"] == {"method": "none"}
    assert entry["fitted_on"]["n"] == len(first.train)
    # The date is the newest label's, never the clock's.
    assert lock_a["created_at"] == max(e.moment["labelled_at"] for e in first.train + first.test)


def test_sessions_never_land_on_both_sides_of_the_split() -> None:
    fit = fit_decision(stuck_set(), "stuck", target=0.05, confidence=0.95, test_share=0.25)
    train = {e.moment["session"] for e in fit.train}
    test = {e.moment["session"] for e in fit.test}
    assert train and test and not train & test
    assert all(is_test_session(s, 0.25) for s in test)
    assert not fit_decision(stuck_set(), "stuck", target=0.05, confidence=0.95, test_share=0).test


def test_too_few_labels_are_refused_with_how_many_are_needed() -> None:
    few = [moment(i, label="stuck", p=0.99) for i in range(20)]
    fit = fit_decision(few, "stuck", target=0.05, confidence=0.95, test_share=0)
    assert fit.thresholds is None
    assert "no threshold acts on 59 or more" in (fit.problem or "")
    assert build_lock([fit], target=0.05, confidence=0.95, holdout_rate=0.1, created_by="t") is None
    looser = fit_decision(few, "stuck", target=0.15, confidence=0.95, test_share=0)
    assert looser.thresholds is not None


def test_moments_for_an_older_question_or_without_a_score_are_left_out() -> None:
    moments = stuck_set()
    moments.append(moment(900, label="stuck", p=0.99, question="sha256:" + "d" * 64))
    moments.append(moment(901, label="stuck"))
    moments.append(moment(902))
    # The newest moment carries today's question.
    moments.append(moment(5000, p=0.5))
    fit = fit_decision(moments, "stuck", target=0.05, confidence=0.95, test_share=0.25)
    assert fit.excluded["built for an older question"] == 1
    assert fit.excluded["not labelled"] == 2
    assert fit.excluded["not scored by openrouter (microsoft/microsoft-decision-1-20261009)"] == 1


def test_fresh_start_fits_both_suggestions_together() -> None:
    def p(cont: float, compact: float, clear: float) -> dict[str, float]:
        return {"continue": cont, "compact": compact, "clear": clear}

    moments = [
        moment(i, decision="fresh_start", label="clear", p=p(0.01, 0.01, 0.98)) for i in range(80)
    ]
    moments += [
        moment(100 + i, decision="fresh_start", label="compact", p=p(0.02, 0.97, 0.01))
        for i in range(80)
    ]
    moments += [
        moment(200 + i, decision="fresh_start", label="continue", p=p(0.6, 0.3, 0.1))
        for i in range(80)
    ]
    fit = fit_decision(moments, "fresh_start", target=0.05, confidence=0.95, test_share=0)
    assert fit.thresholds is not None
    assert set(fit.thresholds) == {"compact", "clear"}
    assert fit.train_outcome is not None and fit.train_outcome.false_alarms == 0
    assert fit.train_outcome.acts == 160
    # One act threshold for both suggestions: the highest that still acts on all 160.
    assert fit.thresholds["compact"] == fit.thresholds["clear"] == {"act": 0.97, "unsure": 0.97}


def test_the_descent_stops_at_the_first_failure() -> None:
    # Right from 0.99 to 0.90; wrong too often at 0.89; right again lower down.
    moments = [moment(i, label="stuck", p=0.9 + (i % 10) / 100) for i in range(200)]
    moments += [moment(200 + i, label="progressing", p=0.89) for i in range(20)]
    moments += [moment(300 + i, label="stuck", p=0.6) for i in range(2000)]
    fit = fit_decision(moments, "stuck", target=0.05, confidence=0.95, test_share=0)
    assert fit.thresholds is not None
    assert fit.thresholds["stuck"]["act"] == 0.9
    assert [step.threshold for step in fit.steps][-1] == 0.89
    assert not fit.steps[-1].passed(0.05)


def test_the_bound_holds_on_simulated_data() -> None:
    """The chance of keeping a threshold whose real false-alarm rate is above the target
    is at most one minus the confidence (here 5%), however the scores fall."""
    rng = random.Random(20261020)
    examples_per_run = 400
    runs = 400
    too_risky = 0
    for _ in range(runs):
        moments = []
        for i in range(examples_per_run):
            p = round(rng.uniform(0.5, 1.0), 2)
            # The real chance the label is wrong when acting at p: 2% from 0.9 up, 12% below.
            wrong = rng.random() < (0.02 if p >= 0.9 else 0.12)
            moments.append(moment(i, label="progressing" if wrong else "stuck", p=p))
        fit = fit_decision(moments, "stuck", target=0.05, confidence=0.95, test_share=0)
        if fit.thresholds is None:
            continue
        act = fit.thresholds["stuck"]["act"]
        # The real false-alarm rate of acting at or above `act`, from the simulation itself.
        span = [round(0.5 + k / 100, 2) for k in range(51)]
        weights = [(0.02 if q >= 0.9 else 0.12) for q in span if q >= act]
        if sum(weights) / len(weights) > 0.05:
            too_risky += 1
    assert too_risky / runs <= 0.05 + 0.02


def test_descend_reports_every_threshold_it_tried() -> None:
    examples = fit_decision(stuck_set(), "stuck", target=0.05, confidence=0.95, test_share=0).train
    kept, steps = descend(examples, ["stuck"], 0.05, 0.95)
    assert kept is not None and kept.threshold == 0.98
    assert [s.threshold for s in steps] == [0.99, 0.98, 0.97]


def test_the_rules_engine_is_used_when_no_model_scored_the_labels() -> None:
    rules = {
        "engine": {"kind": "rules"},
        "probabilities": {"progressing": 0.1, "stuck": 0.9},
        "at": "2026-10-19T08:00:00.000Z",
    }
    moments = [moment(i, label="stuck", extra_scores=[rules]) for i in range(70)]
    fit = fit_decision(moments, "stuck", target=0.05, confidence=0.95, test_share=0)
    assert fit.engine == ("rules", "")
    # Every score is 0.9: the lock acts from there, not from below the scores it has seen,
    # and with nothing between the two thresholds there is no unsure band.
    assert fit.thresholds == {"stuck": {"act": 0.9, "unsure": 0.9}}


# Check ---------------------------------------------------------------------


def _lock(moments: list[dict[str, Any]]) -> dict[str, Any]:
    fit = fit_decision(moments, "stuck", target=0.05, confidence=0.95, test_share=0.25)
    lock = build_lock([fit], target=0.05, confidence=0.95, holdout_rate=0.1, created_by="t")
    assert lock is not None
    return lock


def _rescore(moments: list[dict[str, Any]], shift: float = 0.0, version: str | None = None) -> None:
    for m in moments:
        old = m["scores"][-1]
        engine = {**old["engine"], **({"model_version": version} if version else {})}
        stuck = min(1.0, max(0.0, old["probabilities"]["stuck"] + shift))
        m["scores"].append(
            {
                "engine": engine,
                "probabilities": {"progressing": round(1 - stuck, 4), "stuck": round(stuck, 4)},
                "at": "2026-10-25T08:00:00.000Z",
            }
        )


def test_check_passes_when_nothing_changed() -> None:
    moments = stuck_set()
    lock = _lock(moments)
    _rescore(moments)
    [result] = check_lock(lock, moments)
    assert result.failures == []
    assert any("mean change 0.000" in line for line in result.lines)


def test_check_fails_on_a_new_model_version() -> None:
    moments = stuck_set()
    lock = _lock(moments)
    _rescore(moments, version="microsoft/microsoft-decision-1-20261201")
    [result] = check_lock(lock, moments)
    assert any("model version changed" in f for f in result.failures)


def test_check_fails_on_drift_and_on_false_alarms() -> None:
    moments = stuck_set()
    lock = _lock(moments)
    _rescore(moments, shift=0.3)
    [result] = check_lock(lock, moments)
    assert any("drifted" in f for f in result.failures)
    assert any("changed band" in f for f in result.failures)
    assert any("above the target" in f for f in result.failures)


def test_a_copy_from_a_forked_session_counts_once() -> None:
    moments = stuck_set()
    copies = [{**m, "id": m["id"] + "-fork", "session": "fork"} for m in moments[:12]]
    fit = fit_decision(moments + copies, "stuck", target=0.05, confidence=0.95, test_share=0)
    assert fit.excluded["a copy from a forked or resumed session"] == 12
    assert len(fit.train) == len(moments)
    # A scored copy is used even when an unscored copy sorts first.
    unscored = {**moments[0], "id": "a-copy", "session": "a-session", "scores": []}
    fit = fit_decision([unscored, *moments], "stuck", target=0.05, confidence=0.95, test_share=0)
    assert any(e.moment["id"] == moments[0]["id"] for e in fit.train)


def test_the_fit_uses_one_model_version_only() -> None:
    old = [moment(i, label="progressing", p=0.99, version="m-2025") for i in range(100)]
    new = stuck_set()
    for m in new:
        m["scores"][0]["at"] = "2026-10-20T08:00:00.000Z"
    fit = fit_decision(old + new, "stuck", target=0.05, confidence=0.95, test_share=0)
    assert fit.model_version == "microsoft/microsoft-decision-1-20261009"
    assert fit.excluded["scored only by an older model version"] == 100
    assert fit.thresholds is not None and fit.thresholds["stuck"]["act"] == 0.98


def test_check_fails_when_the_question_changed() -> None:
    moments = stuck_set()
    lock = _lock(moments)
    lock["decisions"]["stuck"]["question_hash"] = "sha256:" + "e" * 64
    [result] = check_lock(lock, moments)
    assert result.failures == ["the question wording changed since the fit; label and fit again"]


# Label ---------------------------------------------------------------------


def test_labelling_saves_each_answer_and_can_skip_undo_and_quit(tmp_path: Path) -> None:
    path = tmp_path / "moments.jsonl"
    moments = [moment(i, p=0.9) for i in range(4)]
    write_moments(path, moments)
    answers = iter(["s", "nonsense", "p", "u", "x", "s", "q"])
    said: list[str] = []
    saves: list[int] = []

    def save(p: Path, moment_id: str, label: str | None, at: str | None) -> None:
        save_label(p, moment_id, label, at)
        saves.append(sum("label" in m for m in read_moments(p)))

    counts = label_moments(
        moments,
        path,
        ask=lambda _: next(answers),
        say=said.append,
        save=save,
        clock=lambda: "2026-10-20T10:00:00.000Z",
    )
    assert counts == {"labelled": 2, "skipped": 1, "undone": 1}
    assert saves == [1, 2, 1, 2]
    assert any("Type one of" in line for line in said)
    assert not any("Model:" in line for line in said)
    stored = read_moments(path)
    assert sorted(m.get("label", "-") for m in stored) == ["-", "-", "stuck", "stuck"]
    assert all(m["labelled_at"] == "2026-10-20T10:00:00.000Z" for m in stored if "label" in m)


def test_with_show_model_enter_accepts_the_models_answer(tmp_path: Path) -> None:
    path = tmp_path / "moments.jsonl"
    moments = [moment(1, p=0.93)]
    write_moments(path, moments)
    said: list[str] = []
    label_moments(moments, path, show_model=True, ask=lambda _: "", say=said.append)
    assert moments[0]["label"] == "stuck"
    assert any("Model: stuck 0.93" in line for line in said)
    assert any("Nothing left" in line for line in [*said, *_again(moments, path)])


def _again(moments: list[dict[str, Any]], path: Path) -> list[str]:
    said: list[str] = []
    label_moments(moments, path, ask=lambda _: "q", say=said.append)
    return said


def test_moments_come_one_session_at_a_time_with_the_question_for_their_trigger() -> None:
    moments = [moment(i, p=0.9, session=f"s{i % 3}") for i in range(9)]
    order = labelling_order(moments)
    assert sorted(m["id"] for m in order) == sorted(m["id"] for m in moments)
    assert len({m["session"] for m in order[:3]}) == 3
    assert len({m["session"] for m in order[3:6]}) == 3
    assert labelling_order(list(reversed(moments))) == order

    fresh = moment(1, decision="fresh_start", p={"continue": 0.2, "compact": 0.3, "clear": 0.5})
    assert question_for(fresh) == "What was the best way to go on with this new prompt?"
    assert question_for({**fresh, "trigger": "turn"}).startswith("The agent has just finished")
    assert question_for({**fresh, "trigger": "idle"}).startswith("The session has been idle")
    said: list[str] = []
    label_moments(
        [{**fresh, "trigger": "idle"}], Path("unused"), ask=lambda _: "q", say=said.append
    )
    assert any(line.startswith("The session has been idle") for line in said)


def test_labelling_stops_cleanly_at_the_end_of_input(tmp_path: Path) -> None:
    def closed(_: str) -> str:
        raise EOFError

    moments = [moment(1, p=0.9)]
    counts = label_moments(moments, tmp_path / "m.jsonl", ask=closed, say=lambda _: None)
    assert counts["labelled"] == 0


# Report --------------------------------------------------------------------


def test_the_report_shows_moments_thresholds_and_events_and_escapes_text(tmp_path: Path) -> None:
    moments = stuck_set()
    moments[0]["state"]["lines"] = ["<script>alert(1)</script>"]
    lock = _lock(moments)
    events_dir = tmp_path / "events.d"
    events_dir.mkdir()
    example = (EXAMPLES / "events.example.jsonl").read_text("utf-8")
    (events_dir / "claude-code-s.jsonl").write_text(example + "not json\n", encoding="utf-8")
    events, skipped = read_events(tmp_path)
    assert skipped == 1 and len(events) == 6
    html = build_report(moments, lock, events, skipped, generated="2026-10-20 10:00 UTC")
    assert "<script>" not in html
    assert "The fitted thresholds" in html
    assert "What each act threshold would do" in html
    assert "twosystems receipt" in html
    assert "created by Shashikant" in html


def test_the_report_works_before_any_moment_is_scored() -> None:
    html = build_report([moment(1), moment(2, label="stuck")], None, [], 0, generated="now")
    assert "No moment has a score yet" in html


# Command line --------------------------------------------------------------


def test_fit_and_check_from_the_command_line(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    moments_path = tmp_path / "moments.jsonl"
    lock_path = tmp_path / "decisions.lock"
    write_moments(moments_path, stuck_set())
    assert main(["fit", "--moments", str(moments_path), "--out", str(lock_path)]) == 0
    out = capsys.readouterr().out
    assert "stuck (openrouter (microsoft/microsoft-decision-1-20261009)):" in out
    assert "act at 0.98" in out and "false-alarm upper bound" in out
    assert "test part: acts on" in out
    assert "Nothing reads it there" in out
    assert "fresh_start (rules):" in out and "not fitted: no labelled moments" in out
    first = lock_path.read_bytes()
    assert main(["fit", "--moments", str(moments_path), "--out", str(lock_path)]) == 1
    assert "already exists" in capsys.readouterr().err
    assert main(["fit", "--moments", str(moments_path), "--out", str(lock_path), "--force"]) == 0
    assert lock_path.read_bytes() == first
    assert main(["validate", "lock", str(lock_path)]) == 0
    assert main(["validate", "moments", str(moments_path)]) == 0

    moments = read_moments(moments_path)
    _rescore(moments)
    write_moments(moments_path, moments)
    capsys.readouterr()
    assert main(["check", "--moments", str(moments_path), "--lock", str(lock_path)]) == 0
    assert capsys.readouterr().out.strip().endswith("PASS")
    assert main(["fit", "--moments", str(moments_path), "--target", "0.9"]) == 2
    assert main(["check", "--moments", str(moments_path), "--lock", str(tmp_path / "none")]) == 2

    report = tmp_path / "report.html"
    assert (
        main(
            [
                "report",
                "--moments",
                str(moments_path),
                "--lock",
                str(lock_path),
                "--out",
                str(report),
            ]
        )
        == 0
    )
    assert "twosystems calibration report" in report.read_text("utf-8")


def test_a_missing_moments_file_is_explained(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["fit", "--moments", str(tmp_path / "none.jsonl")]) == 2
    assert "Run `twosystems moments` first" in capsys.readouterr().err
