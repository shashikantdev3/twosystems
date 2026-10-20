"""twosystems-calibrate: command line for the twosystems calibration tools.

validate checks a file; label, fit, check and report work on the moments that
`twosystems moments` (npm) finds in saved Claude Code sessions.
Exit codes: 0 valid or passed, 1 invalid or failed, 2 usage or file problem.
Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import __version__
from .check import check_lock
from .contracts import MAX_LOCK_BYTES, iter_events_jsonl, validate_lock, validate_lock_text
from .fit import DECISIONS, build_lock, fit_decision
from .label import label_counts, label_moments
from .moments import (
    MomentsFileError,
    data_home,
    default_lock_path,
    default_moments_path,
    engine_name,
    read_moments,
)
from .report import build_report, read_events
from .stats import fewest_tries

#: Largest events log this command reads at once.
MAX_EVENTS_FILE_BYTES = 64 * 1024 * 1024
#: The command prints at most this many problems, and stops reading an events log there.
MAX_PROBLEMS = 100


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="twosystems-calibrate",
        description="Calibration and checking tools for twosystems, created by Shashikant.",
    )
    parser.add_argument(
        "--version", action="version", version=f"twosystems-calibrate {__version__}"
    )
    commands = parser.add_subparsers(dest="command")
    validate = commands.add_parser(
        "validate", help="check an events log or a decisions.lock file against the shared schemas"
    )
    validate.add_argument("kind", choices=["events", "lock", "moments"])
    validate.add_argument("path", type=Path)

    moments_help = "moments file (default: ~/.twosystems/moments.jsonl)"
    label = commands.add_parser("label", help="label moments by hand, one key per moment")
    label.add_argument("--moments", type=Path, help=moments_help)
    label.add_argument("--decision", choices=list(DECISIONS), help="label only this decision")
    label.add_argument(
        "--show-model",
        action="store_true",
        help="show the decision model's answer; Enter accepts it (quicker, but it can sway you)",
    )

    fit = commands.add_parser(
        "fit", help="fit thresholds on labelled moments and write decisions.lock"
    )
    fit.add_argument("--moments", type=Path, help=moments_help)
    fit.add_argument(
        "--out", type=Path, help="lock to write (default: ~/.twosystems/decisions.lock)"
    )
    fit.add_argument("--force", action="store_true", help="replace an existing lock")
    fit.add_argument(
        "--target", type=float, default=0.05, help="highest false-alarm rate allowed (default 0.05)"
    )
    fit.add_argument(
        "--confidence", type=float, default=0.95, help="confidence of the bound (default 0.95)"
    )
    fit.add_argument(
        "--test-share",
        type=float,
        default=0.25,
        help="share of sessions kept out of fitting, to test on (default 0.25)",
    )
    fit.add_argument(
        "--holdout",
        type=float,
        default=0.1,
        help="share of moments kept silent at run time (default 0.1)",
    )
    fit.add_argument(
        "--engine",
        help="engine to fit for, as kind or kind:model (default: the most used decision model)",
    )

    check = commands.add_parser(
        "check", help="check decisions.lock against labelled moments scored again"
    )
    check.add_argument("--moments", type=Path, help=moments_help)
    check.add_argument(
        "--lock", type=Path, help="lock to check (default: ~/.twosystems/decisions.lock)"
    )
    check.add_argument(
        "--max-drift",
        type=float,
        default=0.05,
        help="largest mean change in probability (default 0.05)",
    )
    check.add_argument(
        "--max-band-changes",
        type=float,
        default=0.10,
        help="largest share of moments changing band (default 0.10)",
    )

    report = commands.add_parser(
        "report", help="write an HTML report of moments, thresholds and decisions"
    )
    report.add_argument("--moments", type=Path, help=moments_help)
    report.add_argument(
        "--lock", type=Path, help="lock to show (default: ~/.twosystems/decisions.lock, if any)"
    )
    report.add_argument(
        "--out", type=Path, default=Path("twosystems-report.html"), help="where to write it"
    )

    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help(sys.stderr)
        return 2
    if args.command != "validate":
        _readable_output()
        try:
            return COMMANDS[args.command](args)
        except MomentsFileError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
    if args.kind == "moments":
        return _validate_moments(args.path)

    # A lock may carry a 3-byte byte order mark on top of its size limit.
    limit = MAX_EVENTS_FILE_BYTES if args.kind == "events" else MAX_LOCK_BYTES + 3
    try:
        with args.path.open("rb") as file:
            data = file.read(limit + 1)
    except OSError as error:
        print(f"error: cannot read {args.path}: {error.strerror}", file=sys.stderr)
        return 2
    except MemoryError:
        print(f"error: not enough memory to read {args.path}", file=sys.stderr)
        return 2
    if len(data) > limit:
        if args.kind == "lock":
            print(f"longer than {MAX_LOCK_BYTES} bytes", file=sys.stderr)
            print("FAIL: 1 problem(s)", file=sys.stderr)
            return 1
        print(f"error: {args.path} is larger than 64 MiB; split it first", file=sys.stderr)
        return 2
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        print(f"error: {args.path} is not UTF-8 text", file=sys.stderr)
        return 2

    if args.kind == "events":
        return _report_events(text)
    result = validate_lock_text(text)
    if result.ok:
        print("OK: decisions.lock valid")
        return 0
    for problem in result.errors[:MAX_PROBLEMS]:
        print(problem, file=sys.stderr)
    shown = "" if len(result.errors) <= MAX_PROBLEMS else f", first {MAX_PROBLEMS} shown"
    print(f"FAIL: {len(result.errors)} problem(s){shown}", file=sys.stderr)
    return 1


def _report_events(text: str) -> int:
    """Check an events log line by line and stop after MAX_PROBLEMS problems."""
    count = problems = 0
    for number, errors in iter_events_jsonl(text):
        count += 1
        for error in errors:
            if problems == MAX_PROBLEMS:
                print(f"FAIL: stopped after {MAX_PROBLEMS} problems", file=sys.stderr)
                return 1
            print(f"line {number}: {error}", file=sys.stderr)
            problems += 1
    if problems:
        print(f"FAIL: {problems} problem(s)", file=sys.stderr)
        return 1
    print(f"OK: {count} events valid")
    return 0


def _readable_output() -> None:
    """Never crash on a character the console cannot show (a Windows console, say)."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(errors="replace")
            except (ValueError, OSError):
                pass


def _validate_moments(path: Path) -> int:
    try:
        moments = read_moments(path)
    except MomentsFileError as error:
        print(str(error), file=sys.stderr)
        print("FAIL: 1 problem(s)", file=sys.stderr)
        return 1
    print(f"OK: {len(moments)} moments valid")
    return 0


def _summary(moments: list[dict[str, Any]]) -> str:
    counts = label_counts(moments)
    parts = []
    for name in DECISIONS:
        c = counts.get(name)
        if c is None:
            continue
        given = ", ".join(f"{label} {n}" for label, n in sorted(c["labels"].items())) or "none"
        parts.append(f"{name}: {c['labelled']} of {c['moments']} labelled ({given})")
    return "; ".join(parts) or "no moments"


def _label(args: argparse.Namespace) -> int:
    path = args.moments or default_moments_path()
    moments = read_moments(path)
    print(f"{path}: {_summary(moments)}")
    label_moments(moments, path, decision=args.decision, show_model=args.show_model)
    return 0


def _parse_engine(text: str | None) -> tuple[str, str] | None:
    if text is None:
        return None
    kind, _, model = text.partition(":")
    return (kind, model)


def _between(name: str, value: float, low: float, high: float) -> str | None:
    return None if low <= value <= high else f"--{name} must be between {low:g} and {high:g}"


def _fit(args: argparse.Namespace) -> int:
    for problem in (
        _between("target", args.target, 0.001, 0.5),
        _between("confidence", args.confidence, 0.5, 0.999),
        _between("test-share", args.test_share, 0, 0.9),
        _between("holdout", args.holdout, 0, 0.5),
    ):
        if problem:
            print(f"error: {problem}", file=sys.stderr)
            return 2
    path = args.moments or default_moments_path()
    out = args.out or default_lock_path()
    moments = read_moments(path)
    fits = [
        fit_decision(
            moments,
            name,
            target=args.target,
            confidence=args.confidence,
            test_share=args.test_share,
            engine=_parse_engine(args.engine),
        )
        for name in DECISIONS
    ]
    need = fewest_tries(args.target, args.confidence)
    for f in fits:
        print(f"{f.decision} ({engine_name(f.engine)}):")
        skipped = ", ".join(f"{n} {why}" for why, n in sorted(f.excluded.items()))
        print(
            f"  {len(f.train)} labelled moment(s) to fit on, {len(f.test)} to test on"
            + (f"; left out: {skipped}" if skipped else "")
        )
        if f.thresholds is None:
            print(f"  not fitted: {f.problem}")
            continue
        assert f.train_outcome is not None and f.upper is not None
        first = next(iter(f.thresholds.values()))
        print(
            f"  act at {first['act']:.2f}, unsure at {first['unsure']:.2f} "
            f"(for {' and '.join(f.thresholds)}); {len(f.steps)} threshold(s) tested from the top"
        )
        fitted = f.train_outcome
        print(
            f"  fitting part: acts on {fitted.acts} of {fitted.moments}, wrongly "
            f"{fitted.false_alarms}; false-alarm upper bound {f.upper:.1%} "
            f"(target {args.target:.1%}, {args.confidence:.0%} confidence)"
        )
        tested = f.test_outcome
        if tested is None:
            print("  test part: no labelled moments in the test sessions")
            continue
        if tested.acts == 0 or f.test_upper is None:
            print(f"  test part: acts on none of {tested.moments}, so it cannot tell yet")
            continue
        summary = (
            f"  test part: acts on {tested.acts} of {tested.moments}, wrongly "
            f"{tested.false_alarms}; false-alarm upper bound {f.test_upper:.1%}"
        )
        if tested.acts < need:
            verdict = f"too few acts to confirm the target (it takes at least {need})"
        elif f.test_upper <= args.target:
            verdict = "confirms the target"
        else:
            verdict = "does NOT confirm the target; label more before relying on this lock"
        print(f"{summary}: {verdict}")
    lock = build_lock(
        fits,
        target=args.target,
        confidence=args.confidence,
        holdout_rate=args.holdout,
        created_by=f"twosystems-calibrate {__version__} fit",
    )
    if lock is None:
        print("No decision could be fitted, so no lock was written.", file=sys.stderr)
        return 1
    problems = validate_lock(lock).errors
    if problems:
        print(
            f"error: the fitted lock is not valid ({problems[0]}); please report this",
            file=sys.stderr,
        )
        return 1
    if out.exists() and not args.force:
        print(
            f"{out} already exists; add --force to replace it, or choose another --out.",
            file=sys.stderr,
        )
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"Wrote {out}. {_who_reads(out)}")
    return 0


def _who_reads(out: Path) -> str:
    """Which adapters will use a lock written here."""
    plugin_lock = data_home() / "decisions.lock"
    if _same_file(out, plugin_lock):
        if _same_file(out, default_lock_path()):
            return "The twosystems command and the Claude Code plugin use it from their next start."
        return (
            "The Claude Code plugin uses it from its next start; the twosystems command reads "
            "TWOSYSTEMS_LOCK instead."
        )
    if _same_file(out, default_lock_path()):
        return (
            "The twosystems command (TWOSYSTEMS_LOCK) uses it from its next start; the Claude "
            f"Code plugin reads only {plugin_lock}."
        )
    return (
        f"Nothing reads it there: copy it to {plugin_lock} for the Claude Code plugin and the "
        "twosystems command, or set TWOSYSTEMS_LOCK to it for the twosystems command."
    )


def _same_file(a: Path, b: Path) -> bool:
    return a.expanduser().resolve() == b.expanduser().resolve()


def _read_lock(path: Path) -> dict[str, Any] | None:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    result = validate_lock_text(text)
    if not result.ok:
        raise MomentsFileError(f"{path} is not a valid decisions.lock: {result.errors[0]}")
    return json.loads(text.lstrip("\ufeff"))


def _check(args: argparse.Namespace) -> int:
    lock_path = args.lock or default_lock_path()
    lock = _read_lock(lock_path)
    if lock is None:
        print(
            f"error: {lock_path} does not exist; run twosystems-calibrate fit first",
            file=sys.stderr,
        )
        return 2
    moments = read_moments(args.moments or default_moments_path())
    failed = False
    for result in check_lock(
        lock, moments, max_drift=args.max_drift, max_band_changes=args.max_band_changes
    ):
        print(f"{result.decision}:")
        for line in result.lines:
            print(f"  {line}")
        for failure in result.failures:
            print(f"  FAIL: {failure}")
        failed = failed or bool(result.failures)
    print("FAIL" if failed else "PASS")
    return 1 if failed else 0


def _report(args: argparse.Namespace) -> int:
    moments = read_moments(args.moments or default_moments_path())
    lock = _read_lock(args.lock or default_lock_path())
    events, skipped = read_events(data_home())
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    args.out.write_text(
        build_report(moments, lock, events, skipped, generated=generated), encoding="utf-8"
    )
    print(f"Wrote {args.out}")
    return 0


COMMANDS = {"label": _label, "fit": _fit, "check": _check, "report": _report}


if __name__ == "__main__":
    sys.exit(main())
