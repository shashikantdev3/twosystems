# Architecture

This document describes how twosystems is put together. It is a living document and changes as the code lands. Decisions with lasting consequences are recorded separately in [decisions/](decisions/).

## One brain, thin adapters

```
                 decisions.lock  (thresholds, produced by the Python package)
                        |
        +---------------v----------------+
        |  twosystems core (TypeScript)  |  signals, decision engines,
        |  bundled into each adapter     |  holdout, receipt maths
        +---+------------+-----------+---+
            |            |           |
   Claude Code plugin  Hook command  VS Code extension
   (inside Claude Code) (called by    (status bar, buttons,
                        Copilot hooks) receipt view, key storage)
            |            |           |
            +-----> ~/.twosystems/events.jsonl <-----+
                        |
     Python package (twosystems-calibrate): label, fit, check, report
```

The decision logic is written once, in TypeScript, because both Claude Code plugins and VS Code extensions run JavaScript. The Python package works offline on the files the core writes: it labels and fits on `moments.jsonl`, which `twosystems moments` builds by replaying saved Claude Code sessions with the core's own signals and summary, at the points where the Claude Code plugin checks, reads the event log for its report, and writes `decisions.lock` (decision 0007).

## Layers

Every decision passes through the same layers. Most turns stop at layer 2 and cost nothing.

| # | Layer | Purpose | Uses a model? |
|---|---|---|---|
| 1 | Capture | Listen to prompts, tool calls, finished turns and usage | No |
| 2 | Signals | Turn events into cheap facts: repeated commands and errors, files changed, test results, context size, idle time | No |
| 3 | System 1 | When signals look suspicious, ask a decision model a typed question about a short summary of the session | Yes, a small decision model |
| 4 | Calibration | Map probabilities to bands (act, unsure, silent) with a bounded false-alarm rate, using thresholds from `decisions.lock` | No (fitted offline) |
| 5 | System 2 | For the unsure band only, if enabled: ask a larger model | Optional, off by default |
| 6 | Human | Show the suggestion with buttons; the user decides | No |
| 7 | Record | Append the decision, the user's choice and usage before and after to the local event log | No |
| 8 | Receipt | Turn the log into estimated, recovery and verified figures | No |

## Cost rule

The watchman must never cost more than it saves. Rules run locally. System 1 runs only on suspicious moments and never draws on the user's Claude or Copilot plan. System 2 is off by default. Suggestions are shown in the interface and add nothing to the agent's context. The receipt subtracts our own cost.

## Contracts

Three files connect the parts. Their JSON Schemas live in [`schemas/`](../schemas/).

- **`events.jsonl`**: one line per event or decision, append-only, stored in `~/.twosystems/`. Adapters that cannot append (the Claude Code plugin) write the same records to one file per session in `~/.twosystems/events.d/`; readers take both.
- **`decisions.lock`**: calibrated thresholds per decision, with the engine and model version they were fitted on. Written by `twosystems-calibrate fit` to `~/.twosystems/decisions.lock`, where the hook command and the Claude Code plugin read it. An entry is used only with the engine and question wording it was fitted for, and not when the model reports a version other than the one it was fitted on; otherwise the built-in thresholds apply and the decision is logged as a lock mismatch.
- **`moments.jsonl`**: the moments of past sessions where twosystems would have asked its decision model, with the redacted summary it would have sent, each engine's answer and the person's label. Written by `twosystems moments`, labelled and fitted by `twosystems-calibrate`. It holds redacted session text, so it stays on the machine.

Both languages validate these files: the TypeScript core with ajv, the Python package with jsonschema. Each also runs checks a schema cannot express, such as every threshold naming a known label. Both apply the same strict rules: well-formed Unicode, the JSON grammar with every number fitting a 64-bit float, no repeated keys and at most 32 levels of nesting, RFC 3339 timestamps with a time zone and no leap seconds, plain UUIDs, a size limit and a value limit per record, and the same way of splitting a log into lines. Both are built to return the same fixed error messages, which never repeat a rejected value. The same valid, invalid and edge-case examples in `schemas/examples/` run in both test suites, with the expected messages written down, so any difference between the two on those cases fails CI. Each package keeps a committed copy of the schemas, and CI fails if a copy differs from the root.

## Adapters

- **Claude Code plugin.** Runs inside Claude Code as a mod (no Node), with a copy of the portable core (`packages/core/src/portable.ts` and what it imports). It reads exact usage for every request, asks through Claude Code's own permission dialog when the agent seems stuck, draws the fresh-start band above the prompt, and adds a receipt line under answers where it did something. It writes one event file per session in `~/.twosystems/events.d/`, because a mod cannot append to a shared file. Receipts here can be verified. See [decision 0006](decisions/0006-claude-code-plugin-as-a-mod.md).
- **Hook command.** `twosystems hook`, called by agent hook systems with JSON on standard input: Claude Code, GitHub Copilot (VS Code agent hooks and the Copilot CLI) and Codex. It reads both payload styles in use, keeps short redacted session notes between calls, asks before the next tool call when the agent seems stuck, and shows a note when a fresh start would help. It always answers with valid JSON and exit code 0. See [decision 0005](decisions/0005-hook-command-and-session-notes.md).
- **VS Code extension.** Installs the hook file with the user's consent, keeps keys in VS Code secret storage, and shows the counter, buttons and receipt. GitHub Copilot does not give hooks or extensions exact token counts, so Copilot receipts are estimates.

## Failure behaviour

Suggestions are advice. If a decision model times out, a key is missing or the machine is offline, twosystems stays silent and records the moment as not evaluated. It never blocks the user's work because of its own failure.

## Privacy

Calibration adds one local file, `moments.jsonl`, with redacted summaries of past moments; it is read from and written to the user's own machine only, and nothing leaves it unless the user scores moments with a remote decision model, which then receives each moment's summary just as a live check would send it. Otherwise, only the short summary sent to System 1 leaves the machine, after a redaction pass for secrets, and the same summary goes to System 2 if the user switches it on. A local decision model or the rules engine, with System 2 off, keeps everything on the machine. Event logs and session notes stay local; session notes hold redacted, shortened text and are deleted after seven days. The Claude Code plugin keeps its recent observations in memory only.
