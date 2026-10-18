# Shared file formats

Two files connect the parts of twosystems. Their JSON Schemas (draft 2020-12) live here and are the single source of truth.

| Schema | File it describes | Written by | Read by |
|---|---|---|---|
| [`events.schema.json`](events.schema.json) | `~/.twosystems/events.jsonl`, one record per line: usage, decisions and the user's choices | Every adapter | Receipt, `twosystems-calibrate` |
| [`decisions-lock.schema.json`](decisions-lock.schema.json) | `decisions.lock`: calibrated thresholds per decision, with the engine and question they were fitted on | `twosystems-calibrate fit` | Every adapter |

## Privacy by design

The event log never stores prompts, code or file contents. A decision records only a hash of the state that was judged. Every string in a record is an enum, a short identifier without spaces, a short code, a hash or a timestamp, and unknown fields are rejected. That makes it hard for a prompt to slip into the log by accident; it cannot stop a deliberately broken adapter, which is why the adapters are tested too.

## Rules both languages apply

The TypeScript core and the Python package validate these files with the same rules, beyond what the schemas say:

- Text must be well-formed Unicode (no unpaired surrogates).
- JSON follows the grammar exactly: no `NaN` or `Infinity`, every number must fit a 64-bit float, no key may appear twice in one object, and arrays and objects may nest at most 32 levels deep.
- Timestamps are RFC 3339 with a time zone (`Z` or `+05:30`). Leap seconds, a space instead of `T`, and offsets like `+0530` are rejected.
- UUIDs are the plain 8-4-4-4-12 form, in either case.
- An event record may be at most 16 KiB and a lock file at most 1 MiB, in UTF-8. An event may hold at most 4,096 values and a lock at most 65,536, counting every object, array, string, number, boolean and null. Real events hold about 50 and the largest real lock about 33,000.
- An event log is split on `\n`, with one trailing `\r` removed per line, so Windows line endings work. A byte order mark at the start of a file is ignored. Lines holding only spaces or tabs are skipped.
- In a lock, every threshold names one of the labels, and `unsure` never exceeds `act`.

Both are built to report the same error messages, sorted, after the same order of checks: Unicode, size, nesting, grammar, number range, repeated keys, number of values, then the schema. The shared edge cases below hold the expected messages, so a difference on those cases fails CI. A message is a fixed sentence built from the schema. It never repeats a rejected value; the only text taken from the input is a field name or a lock label that is a short plain name. A field name that is not a short plain name (letters, digits, `_`, `.` or `-`, up to 32 characters) is shown as `*` in a path and as "(name not shown)" in a message, so a key that holds secret text does not end up in logs.

When the value comes from code rather than text (`validateEvent`, `validate_event` and the lock equivalents), objects shared in several places are counted once per place, so a value costs what the same JSON text would: its values must fit the value limit and the text in its strings and field names must fit the size limit ("too much text"). A cycle counts as nested too deeply. Three differences between the languages remain. Python keeps integers above 2^53 exact, while JavaScript rounds them, so two such numbers can be equal in one language and different in the other. Python rejects a dict key that is not a string ("field names must be strings"), which JavaScript cannot produce. The TypeScript validators expect plain data; an object with a getter that throws, or a proxy, can make them throw.

## Examples

[`examples/`](examples/) holds the cases both test suites run:

- `events.example.jsonl` and `decisions.lock.example.json`: valid files.
- `invalid-events.json` and `invalid-locks.json`: invalid records, each with the reason and the field it must be rejected at.
- `edge-cases.json`: 193 raw-text cases with the expected verdict and the exact list of error messages, covering timestamps, UUIDs, numbers, Unicode, nesting, repeated keys, repeated items, line endings and size limits.

Any difference between the two languages on these cases fails CI. The tests also check the number of cases, so a truncated file fails too.

## Changing a format

Changes to these formats need an issue first, because every adapter depends on them. After a change, run `npm run sync` at the repository root and commit the updated copies in `packages/core/schemas/` and `python/src/twosystems/schemas/`. CI fails if a copy differs from this folder.

Part of [twosystems](../README.md), created by Shashikant.
