"""Validators for the two shared files: the event log and decisions.lock.

The JSON Schemas in /schemas are the source of truth. This module applies
exactly the same rules as the TypeScript core, and both run the shared edge
cases in /schemas/examples, so any difference between the two fails CI.
Part of twosystems, created by Shashikant.
"""

from __future__ import annotations

import calendar
import json
import math
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker, ValidationError, validators

#: Largest event record accepted, in UTF-8 bytes. Real records are under 2 KB.
MAX_EVENT_BYTES = 16_384
#: Largest decisions.lock accepted, in UTF-8 bytes.
MAX_LOCK_BYTES = 1_048_576

# RFC 3339 date-time with a mandatory time zone, checked by hand so that both
# languages apply the same rule: no leap seconds, no space separator, offsets
# as +HH:MM only.
_DATE_TIME = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))",
    re.ASCII,
)
_UUID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", re.ASCII
)
_BLANK = re.compile(r"[ \t]*")


def is_date_time(value: str) -> bool:
    match = _DATE_TIME.fullmatch(value)
    if match is None:
        return False
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    offset_hour, offset_minute = (int(part or "0") for part in match.groups()[6:])
    return (
        year >= 1
        and 1 <= month <= 12
        and 1 <= day <= calendar.monthrange(year, month)[1]
        and hour <= 23
        and minute <= 59
        and second <= 59
        and offset_hour <= 23
        and offset_minute <= 59
    )


def is_uuid(value: str) -> bool:
    return _UUID.fullmatch(value) is not None


_formats = FormatChecker(formats=())


@_formats.checks("date-time")
def _check_date_time(value: object) -> bool:
    return not isinstance(value, str) or is_date_time(value)


@_formats.checks("uuid")
def _check_uuid(value: object) -> bool:
    return not isinstance(value, str) or is_uuid(value)


def _pattern(
    validator: Any, pattern: str, instance: Any, schema: dict[str, Any]
) -> Iterator[ValidationError]:
    """Match "pattern" like ECMAScript.

    A final "$" does not accept a trailing newline, and \\d and \\w match ASCII only.
    """
    if not validator.is_type(instance, "string"):
        return
    backslashes = len(pattern[:-1]) - len(pattern[:-1].rstrip("\\"))
    anchored = pattern.endswith("$") and backslashes % 2 == 0
    regex = pattern[:-1] + r"\Z" if anchored else pattern
    if re.search(regex, instance, re.ASCII) is None:
        yield ValidationError("does not have the expected format")


def _canonical(value: Any) -> Any:
    """A hashable stand-in for a JSON value: equal values give equal results.

    1 and 1.0 are equal, true and 1 are not, and objects ignore key order, as in
    JSON Schema. The TypeScript core builds the same kind of key. Nesting is already
    limited, so the recursion is shallow.
    """
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return (type(value).__name__, value)
    if isinstance(value, float) and not math.isfinite(value):
        return ("number", repr(value))
    if isinstance(value, float) and value.is_integer():
        return ("number", int(value))
    if isinstance(value, (int, float)):
        return ("number", value)
    if isinstance(value, list):
        return ("array", tuple(_canonical(item) for item in value))
    if isinstance(value, dict):
        return ("object", frozenset((key, _canonical(item)) for key, item in value.items()))
    return ("other", id(value))


def _unique_items(
    validator: Any, unique: bool, instance: Any, schema: dict[str, Any]
) -> Iterator[ValidationError]:
    """uniqueItems in linear time. jsonschema compares every pair when items cannot be sorted."""
    if not unique or not validator.is_type(instance, "array"):
        return
    seen: set[Any] = set()
    for item in instance:
        key = _canonical(item)
        if key in seen:
            yield ValidationError("must not contain duplicate items")
            return
        seen.add(key)


def _is_number(checker: Any, instance: Any) -> bool:
    """A JSON number: finite, and small enough to fit in a 64-bit float, as in JavaScript."""
    if isinstance(instance, bool) or not isinstance(instance, (int, float)):
        return False
    if isinstance(instance, int):
        try:
            float(instance)
        except OverflowError:
            return False
        return True
    return math.isfinite(instance)


def _is_integer(checker: Any, instance: Any) -> bool:
    if not _is_number(checker, instance):
        return False
    return isinstance(instance, int) or instance.is_integer()


_types = Draft202012Validator.TYPE_CHECKER.redefine_many(
    {"number": _is_number, "integer": _is_integer}
)
_Validator = validators.extend(
    Draft202012Validator,
    {"pattern": _pattern, "uniqueItems": _unique_items},
    type_checker=_types,
)


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    count: int = 0


@cache
def _validator(name: str) -> Any:
    text = resources.files("twosystems").joinpath("schemas", name).read_text(encoding="utf-8")
    return _Validator(json.loads(text), format_checker=_formats)


#: Deepest nesting of arrays and objects accepted. Real records use at most 6 levels.
MAX_DEPTH = 32
#: Most values (objects, arrays, strings, numbers, booleans and nulls) in one event.
#: Real events hold about 50.
MAX_EVENT_VALUES = 4_096
#: Most values in one decisions.lock. The largest real lock holds about 33,000.
MAX_LOCK_VALUES = 65_536

_SAFE_FIELD = re.compile(r"[A-Za-z0-9_.-]{1,32}", re.ASCII)


def _field_name(name: str) -> str:
    return f"'{name}'" if _SAFE_FIELD.fullmatch(name) else "(name not shown)"


def _path(error: ValidationError) -> str:
    """JSON pointer to the bad value. Field names that are not plain short names show as *."""
    if not error.absolute_path:
        return "<root>"
    parts = []
    for part in error.absolute_path:
        text = str(part)
        parts.append(text if isinstance(part, int) or _SAFE_FIELD.fullmatch(text) else "*")
    return "/" + "/".join(parts)


def _js_number(value: Any) -> str:
    """Write a schema number the way JavaScript's JSON.stringify does."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return json.dumps(value)


def _count(limit: int, noun: str) -> str:
    return f"{limit} {noun}{'' if limit == 1 else 's'}"


def _describe(error: ValidationError) -> list[str]:
    """Fixed sentences built from the schema, never from the rejected value.

    The TypeScript core builds exactly the same sentences, so blocked text cannot
    leak into logs and both languages report the same list.
    """
    path = _path(error)
    keyword = error.validator
    limit = error.validator_value
    if "propertyNames" in error.absolute_schema_path:
        return [f"{path} has an invalid field name"]
    if keyword == "not":
        return [f"{path} is not allowed for this event type"]
    if keyword == "additionalProperties":
        known = error.schema.get("properties", {})
        extra = [key for key in error.instance if key not in known]
        return [f"{path} has an unexpected field {_field_name(key)}" for key in extra]
    if keyword == "required":
        missing = [key for key in limit if key not in error.instance]
        return [f"{path} is missing the required field '{key}'" for key in missing]
    messages = {
        "type": lambda: f"must be {' or '.join(limit) if isinstance(limit, list) else limit}",
        "enum": lambda: "must be one of the allowed values",
        "const": lambda: f"must equal {_js_number(limit)}",
        "pattern": lambda: "does not have the expected format",
        "format": lambda: f"must be a valid {limit}",
        "minimum": lambda: f"must be >= {_js_number(limit)}",
        "maximum": lambda: f"must be <= {_js_number(limit)}",
        "exclusiveMinimum": lambda: f"must be > {_js_number(limit)}",
        "exclusiveMaximum": lambda: f"must be < {_js_number(limit)}",
        "minLength": lambda: f"must have at least {_count(limit, 'character')}",
        "maxLength": lambda: f"must have at most {_count(limit, 'character')}",
        "minItems": lambda: f"must have at least {_count(limit, 'item')}",
        "maxItems": lambda: f"must have at most {_count(limit, 'item')}",
        "uniqueItems": lambda: "must not contain duplicate items",
        "minProperties": lambda: f"must have at least {_count(limit, 'field')}",
        "maxProperties": lambda: f"must have at most {_count(limit, 'field')}",
        "anyOf": lambda: "does not match any allowed shape",
    }
    message = messages.get(keyword)
    return [f"{path} {message() if message else f'is invalid ({keyword})'}"]


def _tidy(messages: list[str]) -> list[str]:
    """Sorted, without duplicates, so both languages produce the same list."""
    return sorted(set(messages))


def _text_bytes(text: str, limit: int) -> int:
    """UTF-8 length of a string, or anything above the limit once it is clearly longer.

    A UTF-8 string is never shorter in bytes than in characters.
    """
    if len(text) > limit:
        return limit + 1
    return len(text.encode("utf-8", "surrogatepass"))


def _measure(
    value: Any, max_values: int, max_bytes: int, seen: dict[int, tuple[int, int]]
) -> tuple[int, int]:
    """Measure a value as if shared objects were copied out.

    Returns how many values it holds and how many UTF-8 bytes its strings and field
    names take. A value built in code then costs what the same JSON text would; text
    that passed the size limit always passes here. Stops measuring past either limit.
    Runs after the depth check, so the recursion is shallow and there are no cycles.
    """
    if isinstance(value, str):
        return 1, _text_bytes(value, max_bytes)
    if not isinstance(value, (dict, list)):
        return 1, 0
    known = seen.get(id(value))
    if known is not None:
        return known
    values, size = 1, 0
    pairs = value.items() if isinstance(value, dict) else (("", item) for item in value)
    for key, child in pairs:
        size += _text_bytes(key, max_bytes)
        child_values, child_bytes = _measure(child, max_values, max_bytes, seen)
        values += child_values
        size += child_bytes
        if values > max_values or size > max_bytes:
            break
    seen[id(value)] = (values, size)
    return values, size


def _shape_problem(value: Any, max_values: int, max_bytes: int) -> str | None:
    """Checks run before the schema, in the same order as the TypeScript core.

    First nesting deeper than MAX_DEPTH (a cycle counts as endless) or a key that is
    not a string, whichever the walk meets first; then more than max_values values;
    then more than max_bytes of text in strings and field names. Values in code can
    share objects: each object is walked again only when it is reached at a deeper
    level than before, so the cost stays linear.
    """
    deepest: dict[int, int] = {}
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if not isinstance(item, (dict, list)):
            continue
        if depth > MAX_DEPTH:
            return "nested too deeply"
        if deepest.get(id(item), 0) >= depth:
            continue
        deepest[id(item)] = depth
        if isinstance(item, dict):
            if not all(isinstance(key, str) for key in item):
                return "field names must be strings"
            children: Any = item.values()
        else:
            children = item
        stack.extend((child, depth + 1) for child in children)
    values, size = _measure(value, max_values, max_bytes, {})
    if values > max_values:
        return "too many values"
    if size > max_bytes:
        return "too much text"
    return None


def _schema_errors(validator: Any, value: Any, max_values: int, max_bytes: int) -> list[str]:
    problem = _shape_problem(value, max_values, max_bytes)
    if problem is not None:
        return [problem]
    return _tidy([m for error in validator.iter_errors(value) for m in _describe(error)])


# A string literal, or an unterminated one running to the end of the text.
_STRING = re.compile(r'"[^"\\]*(?:\\[\s\S][^"\\]*)*"?')
_BRACKET = re.compile(r"[\[\]{}]")


def _nesting_too_deep(text: str) -> bool:
    """Count brackets outside strings in one linear pass, before any parser runs."""
    depth = 0
    for match in _BRACKET.finditer(_STRING.sub("", text)):
        if match.group() in "[{":
            depth += 1
            if depth > MAX_DEPTH:
                return True
        else:
            depth -= 1
    return False


def is_well_formed(text: str) -> bool:
    """True when the text has no unpaired surrogate, so it is valid Unicode."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


#: Integers above this are stored as floats, exactly as JavaScript stores them.
_SAFE_INT = 2**53


def _reject_constant(text: str) -> Any:
    raise ValueError(f"{text} is not valid JSON")


def parse_json(text: str) -> tuple[bool, Any, str]:
    """Parse JSON exactly as the TypeScript core does.

    The JSON grammar, at most MAX_DEPTH levels of nesting, no repeated keys, and
    every number fitting in a 64-bit float. The text must be well-formed Unicode.
    Problems are reported in the same order as in TypeScript: grammar first, then
    number range, then repeated keys. Returns (ok, value, error).
    """
    if not is_well_formed(text):
        return False, None, "not well-formed Unicode text"
    if _nesting_too_deep(text):
        return False, None, "nested too deeply"
    problems: set[str] = set()

    def parse_int(digits: str) -> int | float:
        if len(digits.lstrip("-")) > 309:
            problems.add("range")
            return 0
        number = int(digits)
        if abs(number) <= _SAFE_INT:
            return number
        try:
            return float(number)
        except OverflowError:
            problems.add("range")
            return 0

    def parse_float(digits: str) -> float:
        number = float(digits)
        if not math.isfinite(number):
            problems.add("range")
        return number

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result = dict(items)
        if len(result) != len(items):
            problems.add("duplicate")
        return result

    try:
        value = json.loads(
            text,
            parse_float=parse_float,
            parse_int=parse_int,
            parse_constant=_reject_constant,
            object_pairs_hook=pairs,
        )
    except (ValueError, RecursionError):
        return False, None, "not valid JSON"
    if "range" in problems:
        return False, None, "number out of range"
    if "duplicate" in problems:
        return False, None, "duplicate key"
    return True, value, ""


def _precheck(text: str, max_bytes: int) -> str | None:
    """Checks done before parsing, in the same order as the TypeScript core."""
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        return "not well-formed Unicode text"
    return f"longer than {max_bytes} bytes" if size > max_bytes else None


def _strip_bom(text: str) -> str:
    return text.removeprefix("\ufeff")


def validate_event(value: Any) -> ValidationResult:
    """Validate one event object against events.schema.json."""
    errors = _schema_errors(
        _validator("events.schema.json"), value, MAX_EVENT_VALUES, MAX_EVENT_BYTES
    )
    return ValidationResult(ok=not errors, errors=errors)


def validate_event_text(text: str) -> ValidationResult:
    """Parse and validate one event from JSON text. A leading byte order mark is ignored."""
    body = _strip_bom(text)
    problem = _precheck(body, MAX_EVENT_BYTES)
    if problem is not None:
        return ValidationResult(ok=False, errors=[problem])
    ok, value, error = parse_json(body)
    return validate_event(value) if ok else ValidationResult(ok=False, errors=[error])


def iter_events_jsonl(text: str) -> Iterator[tuple[int, list[str]]]:
    """Yield (line number, errors) for each event line of an events.jsonl text, one at a time.

    Lines are split on "\\n" only, with one trailing "\\r" removed, so files written
    on Windows work. A byte order mark at the start of the file is ignored. Lines
    holding only spaces or tabs are skipped. Use this to stop early on a large file.
    """
    body = _strip_bom(text)
    start, number = 0, 0
    while start <= len(body):
        end = body.find("\n", start)
        if end == -1:
            end = len(body)
        raw = body[start:end]
        start, number = end + 1, number + 1
        line = raw[:-1] if raw.endswith("\r") else raw
        if not _BLANK.fullmatch(line):
            yield number, _line_errors(line)


def _line_errors(line: str) -> list[str]:
    problem = _precheck(line, MAX_EVENT_BYTES)
    if problem is not None:
        return [problem]
    ok, value, error = parse_json(line)
    return validate_event(value).errors if ok else [error]


def validate_events_jsonl(text: str) -> ValidationResult:
    """Validate a whole events.jsonl text. Errors are prefixed with the line number.

    See iter_events_jsonl for how lines are split.
    """
    errors: list[str] = []
    count = 0
    for number, line_errors in iter_events_jsonl(text):
        count += 1
        errors.extend(f"line {number}: {error}" for error in line_errors)
    return ValidationResult(ok=not errors, errors=errors, count=count)


def validate_lock(value: Any) -> ValidationResult:
    """Validate a decisions.lock object.

    The JSON Schema runs first, then the rules a schema cannot express: every
    threshold label must be one of the labels, and unsure must not exceed act.
    """
    errors = _schema_errors(
        _validator("decisions-lock.schema.json"), value, MAX_LOCK_VALUES, MAX_LOCK_BYTES
    )
    if errors:
        return ValidationResult(ok=False, errors=errors)
    for name, decision in value["decisions"].items():
        for label, threshold in decision["thresholds"].items():
            if label not in decision["labels"]:
                errors.append(f"/decisions/{name}/thresholds/{label} is not one of the labels")
            if threshold["unsure"] > threshold["act"]:
                errors.append(f"/decisions/{name}/thresholds/{label} has unsure above act")
    return ValidationResult(ok=not errors, errors=_tidy(errors))


def validate_lock_text(text: str) -> ValidationResult:
    """Parse and validate a decisions.lock from JSON text. A leading byte order mark is ignored."""
    body = _strip_bom(text)
    problem = _precheck(body, MAX_LOCK_BYTES)
    if problem is not None:
        return ValidationResult(ok=False, errors=[problem])
    ok, value, error = parse_json(body)
    return validate_lock(value) if ok else ValidationResult(ok=False, errors=[error])
