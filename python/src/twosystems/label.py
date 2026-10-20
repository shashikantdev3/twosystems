"""Labelling moments by hand, one key per moment.

Moments come in a fixed shuffled order that takes one moment from each session in
turn (sessions and moments ordered by a hash of their ids), so labelling is not
biased by time order, and stopping early still gives a sample spread over many
sessions. Every answer is saved straight away, onto the file as it is on disk then;
quitting and starting again carries on where you stopped.

By default the model's answer is hidden, so it cannot sway yours. With
--show-model it is shown, and Enter accepts it: quicker, but expect the fit to
trust the model a little more than it should.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

import hashlib
import textwrap
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .moments import Moment, MomentGone, engine_key, newest_score, save_label

#: One key and one plain sentence per label, for each decision.
OPTIONS: dict[str, list[tuple[str, str, str]]] = {
    "stuck": [
        (
            "s",
            "stuck",
            "it repeats the same commands or edits, meets the same error again, "
            "and nothing improves",
        ),
        (
            "p",
            "progressing",
            "its recent actions change files, try different approaches or get further",
        ),
    ],
    "fresh_start": [
        (
            "k",
            "continue",
            "the work goes on with the same task and the earlier conversation is still useful",
        ),
        ("m", "compact", "same task, but the conversation is long and mostly old detail"),
        ("c", "clear", "a different task starts, so the earlier conversation is not needed"),
    ],
}

#: What each moment asks, by decision and by what started the check.
QUESTIONS: dict[tuple[str, str], str] = {
    ("stuck", "tool"): "The agent is about to make another tool call. Is it stuck here?",
    ("fresh_start", "prompt"): "What was the best way to go on with this new prompt?",
    ("fresh_start", "turn"): (
        "The agent has just finished a turn. Before the next prompt, what was the best way "
        "to go on?"
    ),
    ("fresh_start", "idle"): (
        "The session has been idle past the prompt cache lifetime. Before the next prompt, "
        "what was the best way to go on?"
    ),
}

#: Moments written before triggers were recorded were all taken at these points.
DEFAULT_TRIGGER = {"stuck": "tool", "fresh_start": "prompt"}


def question_for(moment: Moment) -> str:
    trigger = moment.get("trigger", DEFAULT_TRIGGER[moment["decision"]])
    return QUESTIONS.get(
        (moment["decision"], trigger),
        QUESTIONS[(moment["decision"], DEFAULT_TRIGGER[moment["decision"]])],
    )


def options_for(moment: Moment) -> list[tuple[str, str, str]]:
    """The keys for this moment: only labels the moment itself allows."""
    return [option for option in OPTIONS[moment["decision"]] if option[1] in moment["labels"]]


WIDTH = 100


def order_key(moment: Moment) -> str:
    return hashlib.sha256(moment["id"].encode()).hexdigest()


def labelling_order(moments: list[Moment]) -> list[Moment]:
    """One moment from each session in turn: sessions in a fixed shuffled order, and
    each session's moments too, so the first labels come from many sessions."""
    by_session: dict[str, list[Moment]] = {}
    for m in moments:
        by_session.setdefault(m["session"], []).append(m)
    queues = [
        sorted(group, key=order_key)
        for _, group in sorted(
            by_session.items(), key=lambda item: hashlib.sha256(item[0].encode()).hexdigest()
        )
    ]
    ordered: list[Moment] = []
    for depth in range(max((len(q) for q in queues), default=0)):
        ordered.extend(q[depth] for q in queues if depth < len(q))
    return ordered


def now_stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _model_pick(moment: Moment) -> tuple[str, float] | None:
    """The newest decision-model answer (not the rules engine): its top label and probability."""
    keys = {engine_key(s["engine"]) for s in moment["scores"] if s["engine"]["kind"] != "rules"}
    newest = [newest_score(moment, key) for key in keys]
    scores = [s for s in newest if s is not None]
    if not scores:
        return None
    score = max(scores, key=lambda s: s["at"])
    label, p = max(score["probabilities"].items(), key=lambda item: (item[1], item[0]))
    return label, p


def _show(
    moment: Moment,
    position: int,
    total: int,
    done: int,
    show_model: bool,
    say: Callable[[str], None],
) -> str | None:
    question = question_for(moment)
    options = options_for(moment)
    when = moment["at"][:16].replace("T", " ")
    say("")
    say("=" * WIDTH)
    say(
        f"Moment {position} of {total}  |  {moment['decision']}  |  {when} UTC  |  "
        f"labelled so far: {done}"
    )
    say(f"Signals: {', '.join(moment['signals'])}")
    say("")
    say("What twosystems saw:")
    for line in moment["state"]["lines"]:
        for part in textwrap.wrap(line, WIDTH - 4) or [""]:
            say(f"  {part}")
    if moment.get("after"):
        say("")
        say("What happened next:")
        for line in moment["after"]:
            for part in textwrap.wrap(line, WIDTH - 4) or [""]:
                say(f"  {part}")
    pick = _model_pick(moment) if show_model else None
    if pick is not None:
        say("")
        say(f"Model: {pick[0]} {pick[1]:.2f}  (Enter accepts it)")
    say("")
    say(question)
    for key, label, meaning in options:
        say(f"  {key}  {label}: {meaning}")
    say("  x  skip for now    u  undo the last answer    q  save and quit")
    return pick[0] if pick is not None else None


def label_moments(
    moments: list[Moment],
    path: Path,
    *,
    decision: str | None = None,
    show_model: bool = False,
    ask: Callable[[str], str] = input,
    say: Callable[[str], None] = print,
    save: Callable[[Path, str, str | None, str | None], None] = save_label,
    clock: Callable[[], str] = now_stamp,
) -> dict[str, int]:
    """Ask for a label on each unlabelled moment; return counts labelled, skipped and undone.

    Each answer is saved with `save(path, moment id, label, labelled_at)`, or with
    None to take a label back; by default onto the file as it is on disk then.
    """
    todo = labelling_order(
        [
            m
            for m in moments
            if "label" not in m
            and (decision is None or m["decision"] == decision)
            and options_for(m)
        ]
    )
    done = sum(
        1 for m in moments if "label" in m and (decision is None or m["decision"] == decision)
    )
    counts = {"labelled": 0, "skipped": 0, "undone": 0}
    history: list[Moment] = []
    index = 0
    if not todo:
        say("Nothing left to label.")
        return counts
    while index < len(todo):
        moment = todo[index]
        suggested = _show(moment, index + 1, len(todo), done, show_model, say)
        keys = {key: label for key, label, _ in options_for(moment)}
        while True:
            try:
                answer = ask("> ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                answer = "q"
            if answer == "" and suggested is not None:
                answer = next((k for k, label in keys.items() if label == suggested), "")
            if answer in keys or answer in {"x", "u", "q"}:
                break
            say(f"Type one of: {', '.join(keys)}, x, u or q.")
        if answer == "q":
            break
        if answer == "x":
            counts["skipped"] += 1
            index += 1
            continue
        if answer == "u":
            if not history:
                say("Nothing to undo.")
                continue
            last = history.pop()
            try:
                save(path, last["id"], None, None)
            except MomentGone:
                say("That moment is no longer in the file, so there is nothing to undo.")
                continue
            last.pop("label", None)
            last.pop("labelled_at", None)
            counts["undone"] += 1
            counts["labelled"] -= 1
            done -= 1
            index = todo.index(last)
            continue
        stamp = clock()
        try:
            save(path, moment["id"], keys[answer], stamp)
        except MomentGone:
            # `twosystems moments` kept another copy of it (from a forked session) meanwhile.
            say("This moment is no longer in the file (another copy of it is kept); skipped.")
            counts["skipped"] += 1
            index += 1
            continue
        moment["label"] = keys[answer]
        moment["labelled_at"] = stamp
        history.append(moment)
        counts["labelled"] += 1
        done += 1
        index += 1
    say("")
    say(f"Saved. {counts['labelled']} labelled this time, {done} in total; {path}")
    return counts


def label_counts(moments: list[Moment]) -> dict[str, dict[str, Any]]:
    """Per decision: moments, labelled, and how often each label was given."""
    summary: dict[str, dict[str, Any]] = {}
    for m in moments:
        entry = summary.setdefault(m["decision"], {"moments": 0, "labelled": 0, "labels": {}})
        entry["moments"] += 1
        if "label" in m:
            entry["labelled"] += 1
            entry["labels"][m["label"]] = entry["labels"].get(m["label"], 0) + 1
    return summary
