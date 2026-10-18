"""Contract tests: the shared examples must behave the same here as in the TypeScript core.

Part of twosystems, created by Shashikant.
"""

import json
import time
from importlib.metadata import version
from pathlib import Path
from typing import Any

import pytest

import twosystems
from twosystems.cli import main
from twosystems.contracts import (
    _Validator,
    validate_event,
    validate_events_jsonl,
    validate_lock,
    validate_lock_text,
)

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "schemas" / "examples"


def read(name: str) -> str:
    return (EXAMPLES / name).read_text(encoding="utf-8")


def test_every_valid_example_event_passes() -> None:
    result = validate_events_jsonl(read("events.example.jsonl"))
    assert result.errors == []
    assert result.count == 6


def test_every_invalid_example_event_is_rejected_at_the_expected_field() -> None:
    cases = json.loads(read("invalid-events.json"))
    assert len(cases) == 14
    for case in cases:
        result = validate_event(case["record"])
        assert not result.ok, f"accepted: {case['why']}"
        assert any(e.startswith(case["path"] + " ") for e in result.errors), (
            f"{case['why']}: expected an error at {case['path']}, got {result.errors}"
        )


def test_a_line_that_is_not_json_is_reported_with_its_line_number() -> None:
    result = validate_events_jsonl('\n{"v":1\n')
    assert not result.ok
    assert result.errors[0] == "line 2: not valid JSON"


def test_the_example_lock_passes() -> None:
    assert validate_lock(json.loads(read("decisions.lock.example.json"))).errors == []


def test_every_invalid_example_lock_is_rejected_at_the_expected_field() -> None:
    cases = json.loads(read("invalid-locks.json"))
    assert len(cases) == 5
    for case in cases:
        result = validate_lock(case["lock"])
        assert not result.ok, f"accepted: {case['why']}"
        assert any(e.startswith(case["path"] + " ") for e in result.errors), (
            f"{case['why']}: expected an error at {case['path']}, got {result.errors}"
        )


def test_error_messages_name_the_offending_field() -> None:
    cases = {c["why"]: c["record"] for c in json.loads(read("invalid-events.json"))}
    prompt = cases["unknown top-level field holding a prompt"]
    assert "unexpected field 'prompt'" in " ".join(validate_event(prompt).errors)
    missing = cases["missing session"]
    assert "missing the required field 'session'" in " ".join(validate_event(missing).errors)


@pytest.mark.parametrize("name", ["events.schema.json", "decisions-lock.schema.json"])
def test_packaged_schemas_match_the_repository_root(name: str) -> None:
    packaged = ROOT / "python" / "src" / "twosystems" / "schemas" / name
    assert packaged.read_bytes() == (ROOT / "schemas" / name).read_bytes(), (
        "Run `npm run sync` at the repository root and commit the result."
    )


def test_version_comes_from_package_metadata() -> None:
    assert twosystems.__version__ == version("twosystems")


def test_cli_validates_the_examples(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["validate", "events", str(EXAMPLES / "events.example.jsonl")]) == 0
    assert "OK: 6 events valid" in capsys.readouterr().out
    assert main(["validate", "lock", str(EXAMPLES / "decisions.lock.example.json")]) == 0


def test_cli_accepts_a_lock_with_a_byte_order_mark(tmp_path: Path) -> None:
    lock = tmp_path / "decisions.lock"
    lock.write_text("\ufeff" + read("decisions.lock.example.json"), encoding="utf-8")
    assert main(["validate", "lock", str(lock)]) == 0


def test_cli_exit_codes(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text(json.dumps({"v": 1}) + "\n", encoding="utf-8")
    assert main(["validate", "events", str(bad)]) == 1
    binary = tmp_path / "binary.jsonl"
    binary.write_bytes(b"\xff\xfe\x00")
    assert main(["validate", "events", str(binary)]) == 2
    assert main(["validate", "events", str(tmp_path / "missing.jsonl")]) == 2
    assert main([]) == 2


def _usage_event() -> dict:
    return json.loads(read("events.example.jsonl").splitlines()[0])


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), 10**400])
def test_python_numbers_that_json_cannot_hold_are_rejected(bad: float) -> None:
    event = _usage_event()
    event["usage"]["input_tokens"] = bad
    assert validate_event(event).errors == ["/usage/input_tokens must be integer"]


def test_deep_or_cyclic_python_objects_are_rejected_without_crashing() -> None:
    deep: list = []
    for _ in range(5000):
        deep = [deep]
    event = _usage_event()
    event["usage"]["input_tokens"] = deep
    assert validate_event(event).errors == ["nested too deeply"]
    cyclic = _usage_event()
    cyclic["usage"]["self"] = cyclic
    assert validate_event(cyclic).errors == ["nested too deeply"]
    assert validate_lock(deep).errors == ["nested too deeply"]


def _shared(levels: int) -> Any:
    """A value where each level holds the level below twice, so it expands to 2**levels leaves."""
    value: Any = "s"
    for _ in range(levels):
        value = [value, value]
    return value


def test_shared_objects_are_checked_in_linear_time() -> None:
    started = time.perf_counter()
    assert validate_event(_shared(30)).errors == ["too many values"]
    assert validate_event(_shared(40)).errors == ["nested too deeply"]
    for field, value in [("signals", [_shared(25)]), ("probabilities", {"a": _shared(25)})]:
        event = json.loads(read("events.example.jsonl").splitlines()[1])
        event["decision"][field] = value
        assert validate_event(event).errors == ["too many values"]
    lock = json.loads(read("decisions.lock.example.json"))
    lock["holdout_rate"] = _shared(22)
    assert validate_lock(lock).errors == ["too many values"]
    lock["holdout_rate"] = 0.1
    lock["decisions"]["stuck"]["labels"] = [_shared(24), "b"]
    assert validate_lock(lock).errors == ["too many values"]
    small = _usage_event()
    small["usage"]["input_tokens"] = _shared(8)
    assert validate_event(small).errors == ["/usage/input_tokens must be integer"]
    assert time.perf_counter() - started < 5


def test_a_lock_may_hold_at_most_65536_values() -> None:
    lock = json.loads(read("decisions.lock.example.json"))
    lock["extra"] = []
    others = _count(lock, without="extra")
    for total, expected in [
        (65536, ["<root> has an unexpected field 'extra'"]),
        (65537, ["too many values"]),
    ]:
        lock["extra"] = [0] * (total - others)
        assert _count(lock) == total
        assert validate_lock_text(json.dumps(lock)).errors == expected


def _count(value: Any, without: str = "") -> int:
    """Number of values in a JSON value, leaving out one top-level field's contents."""
    if isinstance(value, dict):
        return 1 + sum(1 if key == without else _count(item) for key, item in value.items())
    if isinstance(value, list):
        return 1 + sum(_count(item) for item in value)
    return 1


def test_long_strings_shared_in_many_places_are_rejected_quickly() -> None:
    big = "x" * 262_144
    started = time.perf_counter()
    assert validate_event([big] * 4000).errors == ["too much text"]
    lock = json.loads(read("decisions.lock.example.json"))
    lock["decisions"]["stuck"]["labels"] = [{"k": big, "i": i} for i in range(16000)]
    assert validate_lock(lock).errors == ["too much text"]
    lock["decisions"]["stuck"]["labels"] = ["progressing", "stuck"]
    lock["created_by"] = "é" * 200
    assert validate_lock(lock).errors == []
    assert time.perf_counter() - started < 5


def test_field_names_must_be_strings() -> None:
    event = _usage_event()
    event["usage"][5] = 1
    assert validate_event(event).errors == ["field names must be strings"]


def test_large_arrays_of_mixed_items_are_checked_in_linear_time() -> None:
    lock = json.loads(read("decisions.lock.example.json"))
    lock["decisions"]["stuck"]["labels"] = ["", *range(20000), 0]
    started = time.perf_counter()
    errors = validate_lock(lock).errors
    assert "/decisions/stuck/labels must not contain duplicate items" in errors
    assert time.perf_counter() - started < 5


def test_cli_reports_a_lock_over_the_size_limit_without_reading_all_of_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    big = tmp_path / "big.lock"
    big.write_bytes(b" " * (2 * 1024 * 1024))
    assert main(["validate", "lock", str(big)]) == 1
    assert "longer than 1048576 bytes" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("pattern", "text", "matches"),
    [
        ("^a$", "a", True),
        ("^a$", "a\n", False),
        ("^a\\$", "a$", True),
        ("^a\\\\$", "a\\", True),
        ("^a\\\\$", "a\\\n", False),
    ],
)
def test_pattern_end_anchor_works_like_javascript(pattern: str, text: str, matches: bool) -> None:
    validator = _Validator({"type": "string", "pattern": pattern})
    assert validator.is_valid(text) is matches


def test_cli_stops_an_events_log_after_100_problems(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    log = tmp_path / "events.jsonl"
    log.write_text("not json\n" * 500, encoding="utf-8")
    assert main(["validate", "events", str(log)]) == 1
    err = capsys.readouterr().err.splitlines()
    assert len(err) == 101
    assert err[-1] == "FAIL: stopped after 100 problems"


def test_cli_shows_the_first_100_lock_problems(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    lock = json.loads(read("decisions.lock.example.json"))
    for i in range(150):
        lock[f"extra_{i}"] = 1
    path = tmp_path / "decisions.lock"
    path.write_text(json.dumps(lock), encoding="utf-8")
    assert main(["validate", "lock", str(path)]) == 1
    err = capsys.readouterr().err.splitlines()
    assert len(err) == 101
    assert err[-1] == "FAIL: 150 problem(s), first 100 shown"
