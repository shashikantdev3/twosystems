"""How a probability becomes a band, exactly as the TypeScript core does it
(packages/core/src/lock.ts). The shared cases in schemas/examples/threshold-cases.json
run in both test suites, so any difference fails CI.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

from collections.abc import Mapping

#: The suggestion shown for each label that can trigger one. Other labels mean "carry on".
LABEL_SUGGESTION: dict[str, str] = {"stuck": "pause", "compact": "compact", "clear": "clear"}

#: The label behind each suggestion.
SUGGESTION_LABEL: dict[str, str] = {v: k for k, v in LABEL_SUGGESTION.items()}


def action_labels(labels: list[str]) -> list[str]:
    """The labels of a question that lead to a suggestion, in the question's order."""
    return [label for label in labels if label in LABEL_SUGGESTION]


def apply_thresholds(
    probabilities: Mapping[str, float], thresholds: Mapping[str, Mapping[str, float]]
) -> dict[str, str]:
    """Turn probabilities into a band.

    Labels with thresholds are checked from the most likely down: the first that
    reaches its act threshold gives "act"; if none does, the first that reaches its
    unsure threshold gives "unsure"; otherwise the band is "silent".
    """
    ranked = sorted(
        (label for label in thresholds if label in LABEL_SUGGESTION),
        key=lambda label: (-probabilities.get(label, 0), label),
    )
    for level in ("act", "unsure"):
        for label in ranked:
            limit = thresholds[label].get(level)
            if limit is not None and probabilities.get(label, 0) >= limit:
                return {"band": level, "suggestion": LABEL_SUGGESTION[label]}
    return {"band": "silent"}
