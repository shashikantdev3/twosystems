"""Reading and writing moments.jsonl, the file `twosystems moments` writes and the
calibration commands label and fit.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .contracts import validate_moment, validate_moment_text

Moment = dict[str, Any]


class MomentsFileError(Exception):
    """A moments file that cannot be read safely."""


def data_home() -> Path:
    """The twosystems data folder: TWOSYSTEMS_HOME, else .twosystems in the home folder."""
    own = os.environ.get("TWOSYSTEMS_HOME", "").strip()
    return Path(own) if own else Path.home() / ".twosystems"


def default_moments_path() -> Path:
    return data_home() / "moments.jsonl"


def default_lock_path() -> Path:
    own = os.environ.get("TWOSYSTEMS_LOCK", "").strip()
    return Path(own) if own else data_home() / "decisions.lock"


def read_moments(path: Path) -> list[Moment]:
    """Every moment in the file, in file order.

    A line that is not a valid moment, or that repeats an id, stops the read with
    its line number, so a later write never drops a label it could not understand.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise MomentsFileError(
            f"{path} does not exist yet. Run `twosystems moments` first "
            "(npm install --global twosystems@alpha)."
        ) from None
    except UnicodeDecodeError:
        raise MomentsFileError(f"{path} is not UTF-8 text") from None
    except OSError as error:
        raise MomentsFileError(f"{path} could not be read ({error.strerror or error})") from None
    if text.startswith("\ufeff"):
        text = text[1:]
    moments: list[Moment] = []
    line_of: dict[str, int] = {}
    for number, raw in enumerate(text.split("\n"), start=1):
        line = raw[:-1] if raw.endswith("\r") else raw
        if line.strip(" \t") == "":
            continue
        result = validate_moment_text(line)
        if not result.ok:
            first = result.errors[0] if result.errors else "not a valid moment"
            raise MomentsFileError(f"{path} line {number}: {first}")
        moment = json.loads(line)
        if moment["id"] in line_of:
            raise MomentsFileError(
                f"{path} line {number}: the id {moment['id']} is already used on line "
                f"{line_of[moment['id']]}"
            )
        line_of[moment["id"]] = number
        moments.append(moment)
    return moments


#: Half a character: a UTF-16 surrogate on its own, which JSON can hold as an escape
#: but UTF-8 cannot encode.
_HALF_CHARACTER = re.compile("[\ud800-\udfff]")


def _json_line(moment: Moment) -> str:
    """One moment as a line of JSON. Text stays readable; a half character read from
    an escape is written back as the same escape, so the line can always be saved."""
    text = json.dumps(moment, ensure_ascii=False, separators=(",", ":"))
    return _HALF_CHARACTER.sub(lambda match: f"\\u{ord(match.group()):04x}", text) + "\n"


def write_moments(path: Path, moments: list[Moment]) -> None:
    """Write the whole file through a temporary file, so a crash never leaves half a file.

    The file is readable by its owner only, like the sessions it comes from. Use
    update_moments when another command may be writing too.
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns():x}.tmp")
    body = "".join(_json_line(m) for m in moments)
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(body)
        # Windows refuses a rename while another program (an editor, a virus scanner)
        # holds the file for a moment, so try a few times before giving up.
        for attempt in range(10):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass


#: How the moments file is shared between commands; the TypeScript core uses the same.
LOCK_WAIT_SECONDS = 10.0
LOCK_STALE_SECONDS = 120.0


@contextmanager
def moments_lock(
    path: Path,
    *,
    clock: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> Iterator[None]:
    """Hold `<path>.lock`, a small file created exclusively, so two commands never
    write moments.jsonl at once; the TypeScript core uses the same lock.

    A lock left by a crashed command is taken over after two minutes, checking just
    before removing it that it is still the same stale file, so two waiters do not
    both take it over (best effort: the check and the removal are two steps). The
    lock is removed afterwards only if it is still this command's.
    """
    lock = path.with_name(f"{path.name}.lock")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    mine = f"{os.getpid()} {datetime.now(timezone.utc).isoformat()} {os.urandom(6).hex()}\n"
    started = clock()
    while True:
        try:
            descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except (FileExistsError, PermissionError) as error:
            # On Windows a lock being deleted by its owner can refuse to open for a moment.
            try:
                seen = lock.stat()
            except FileNotFoundError:
                if isinstance(error, PermissionError):
                    raise MomentsFileError(f"{path.parent} is not writable") from None
                continue
            if clock() - seen.st_mtime > LOCK_STALE_SECONDS and _still(lock, seen):
                try:
                    lock.unlink()
                    continue
                except OSError:
                    pass
            if clock() - started > LOCK_WAIT_SECONDS:
                raise MomentsFileError(
                    f"{path} is being written by another twosystems command. "
                    f"If none is running, delete {lock} and run again."
                ) from None
            sleep(0.1)
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(mine)
        break
    try:
        yield
    finally:
        try:
            if lock.read_text(encoding="utf-8") == mine:
                lock.unlink()
        except (OSError, UnicodeDecodeError):
            pass


def _still(lock: Path, seen: os.stat_result) -> bool:
    """True while the lock is the same file that was judged stale."""
    try:
        now = lock.stat()
    except OSError:
        return False
    return now.st_mtime_ns == seen.st_mtime_ns and now.st_ino == seen.st_ino


class MomentGone(MomentsFileError):
    """The moment is no longer in the file (another command dropped a copy of it)."""


def save_label(path: Path, moment_id: str, label: str | None, labelled_at: str | None) -> None:
    """Set (or with None, remove) one moment's label in the file as it is on disk now,
    under the lock, so moments another command added in the meantime are kept."""
    with moments_lock(path):
        moments = read_moments(path)
        found = next((m for m in moments if m["id"] == moment_id), None)
        if found is None:
            raise MomentGone(f"{path} no longer holds moment {moment_id}")
        if label is None or labelled_at is None:
            found.pop("label", None)
            found.pop("labelled_at", None)
        else:
            if label not in found["labels"]:
                raise MomentsFileError(f"{label} is not one of the labels of moment {moment_id}")
            found["label"] = label
            found["labelled_at"] = labelled_at
        problems = validate_moment(found).errors
        if problems:
            raise MomentsFileError(f"the label could not be saved: {problems[0]}")
        write_moments(path, moments)


def engine_key(engine: dict[str, Any]) -> tuple[str, str]:
    """An engine's identity for matching scores: its kind and model."""
    return (engine["kind"], engine.get("model", ""))


def engine_name(key: tuple[str, str]) -> str:
    kind, model = key
    return f"{kind} ({model})" if model else kind


def newest_score(moment: Moment, key: tuple[str, str]) -> dict[str, Any] | None:
    """The latest score this engine gave the moment, or None."""
    found = [s for s in moment["scores"] if engine_key(s["engine"]) == key]
    return max(found, key=lambda s: s["at"]) if found else None
