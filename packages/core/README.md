# twosystems core

The shared runtime used by every twosystems adapter, written in TypeScript. It will be published on npm as `twosystems`.

**Status:** the shared file formats and their validators are in place (Sprint 0). The engine arrives in Sprint 1. Not yet published. See the [roadmap](https://github.com/shashikantdev3/twosystems/blob/main/docs/roadmap.md).

## Available now

- `validateEvent`, `validateEventText` and `validateEventsJsonl` for the event log.
- `validateLock` and `validateLockText` for `decisions.lock`.
- `parseJson`, `isWellFormed`, `isDateTime` and `isUuid`, plus the limits `MAX_DEPTH`, `MAX_EVENT_BYTES`, `MAX_LOCK_BYTES`, `MAX_EVENT_VALUES` and `MAX_LOCK_VALUES`. They apply the same rules as the Python package and run the same shared edge cases, including the exact error messages; see [`schemas/README.md`](https://github.com/shashikantdev3/twosystems/blob/main/schemas/README.md) for the rules and the few differences when values come from code.
- The JSON Schemas, exported as `twosystems/schemas/*`.

## Coming in Sprint 1

- Signals: repeated commands and errors, files changed, test results, context size, idle time against the cache lifetime.
- State builder that writes a short summary of the moment and removes secrets.
- Decision engines: OpenRouter decisions API (Microsoft-Decision-1, Jev), a local model through Ollama, or none.
- Decision bands read from `decisions.lock`, and holdout assignment.
- Receipt maths: estimated, recovery and verified figures.
- The `twosystems` command: `hook`, `receipt`, `doctor`.

Part of [twosystems](https://github.com/shashikantdev3/twosystems), created by Shashikant. Apache License 2.0.
