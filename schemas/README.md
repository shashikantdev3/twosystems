# Shared file formats

Two files connect the parts of twosystems. Their JSON Schemas will live here, with examples, so the TypeScript core and the Python package always agree.

**Status:** planned for Sprint 0.

- `events.schema.json`: one line per event or decision in `~/.twosystems/events.jsonl`.
- `decisions-lock.schema.json`: calibrated thresholds per decision, with the engine and model version they were fitted on.

Changes to these formats need an issue first, because every adapter depends on them.
