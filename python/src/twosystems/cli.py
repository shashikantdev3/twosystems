"""twosystems-calibrate: command line for the twosystems calibration tools.

Exit codes: 0 valid, 1 invalid, 2 usage or file problem.
Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .contracts import MAX_LOCK_BYTES, iter_events_jsonl, validate_lock_text

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
    validate.add_argument("kind", choices=["events", "lock"])
    validate.add_argument("path", type=Path)

    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help(sys.stderr)
        return 2

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
    for error in result.errors[:MAX_PROBLEMS]:
        print(error, file=sys.stderr)
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


if __name__ == "__main__":
    sys.exit(main())
