# twosystems core

The shared runtime used by every twosystems adapter, written in TypeScript and published on npm as `twosystems`.

**Status:** planned for Sprint 1. See the [roadmap](../../docs/roadmap.md).

## What it will contain

- Event log reader and writer for `~/.twosystems/events.jsonl`.
- Signals: repeated commands and errors, files changed, test results, context size, idle time against the cache lifetime.
- State builder that writes a short summary of the moment and removes secrets.
- Decision engines: OpenRouter decisions API (Microsoft-Decision-1, Jev), a local model through Ollama, or none.
- Decision bands read from `decisions.lock`, and holdout assignment.
- Receipt maths: estimated, recovery and verified figures.
- The `twosystems` command: `hook`, `receipt`, `doctor`.

Part of [twosystems](../../README.md), created by Shashikant.
