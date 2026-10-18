"""Edge cases shared with the TypeScript core.

Each case is raw text, so each language uses its own JSON parser; the expected
verdict and the exact list of error messages are the contract. Part of twosystems,
created by Shashikant.
"""

import json
from pathlib import Path

import pytest

from twosystems.contracts import validate_event_text, validate_events_jsonl, validate_lock_text

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "schemas" / "examples" / "edge-cases.json").read_text(
        encoding="utf-8"
    )
)


# Update this number together with edge-cases.json, so a truncated file fails.
EXPECTED_CASES = 193


def test_all_shared_edge_cases_are_present() -> None:
    assert len(CASES) == EXPECTED_CASES
    assert len({c["name"] for c in CASES}) == len(CASES), "case names must be unique"


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_edge_case(case: dict) -> None:
    if case["kind"] == "jsonl":
        result = validate_events_jsonl(case["text"])
        assert result.ok == case["valid"], result.errors
        assert result.count == case["count"]
        assert result.errors == case["errors"]
    else:
        validate = validate_event_text if case["kind"] == "event" else validate_lock_text
        result = validate(case["text"])
        assert result.ok == case["valid"], result.errors
        assert result.errors == case["errors"]
