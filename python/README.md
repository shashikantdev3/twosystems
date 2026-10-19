# twosystems (Python)

Offline tools for calibrating and checking [twosystems](https://github.com/shashikantdev3/twosystems), a cheap, honest watchman for AI coding agents created by Shashikant. The watchman itself (the `twosystems` command and its hooks for Claude Code, GitHub Copilot and Codex) is on npm; this package works on the files it writes.

**Status: alpha (0.1.0a1).** `twosystems-calibrate validate` works now. The calibration commands arrive in Sprint 3. See the [roadmap](https://github.com/shashikantdev3/twosystems/blob/main/docs/roadmap.md).

```bash
pip install --pre twosystems
twosystems-calibrate validate events ~/.twosystems/events.jsonl
```

## Commands

The command is `twosystems-calibrate`, so it does not clash with the `twosystems` command installed from npm.

- `twosystems-calibrate validate events|lock FILE`: check a file against the shared schemas. Available now. Exit code 0 means valid, 1 invalid, 2 a usage or file problem. It prints at most 100 problems and reads at most 64 MiB of an events log.
- `twosystems-calibrate label`: find candidate moments in your local sessions and label them quickly.
- `twosystems-calibrate fit`: calibrate decisions and write `decisions.lock` with a bounded false-alarm rate.
- `twosystems-calibrate check`: replay a labelled set and fail on drift or a model version change.
- `twosystems-calibrate report`: an HTML report of decisions and savings.

## Library

`twosystems.contracts` offers `validate_event`, `validate_event_text`, `validate_events_jsonl`, `validate_lock`, `validate_lock_text`, `iter_events_jsonl` (one line at a time, to stop early on a large log), `parse_json` and `is_well_formed`, plus the limits `MAX_DEPTH`, `MAX_EVENT_BYTES`, `MAX_LOCK_BYTES`, `MAX_EVENT_VALUES` and `MAX_LOCK_VALUES`. They apply the same rules as the TypeScript core and run the same shared edge cases, including the exact error messages; see [`schemas/README.md`](https://github.com/shashikantdev3/twosystems/blob/main/schemas/README.md) for the rules and the few differences when values come from code.

Part of [twosystems](https://github.com/shashikantdev3/twosystems), created by Shashikant. Apache License 2.0.
