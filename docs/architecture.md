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

The decision logic is written once, in TypeScript, because both Claude Code plugins and VS Code extensions run JavaScript. The Python package works offline on the same files: it reads the event log and session transcripts, and writes `decisions.lock`.

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

Two files connect the parts. Their JSON Schemas live in [`schemas/`](../schemas/).

- **`events.jsonl`**: one line per event or decision, append-only, stored in `~/.twosystems/`.
- **`decisions.lock`**: calibrated thresholds per decision, with the engine and model version they were fitted on.

## Adapters

- **Claude Code plugin.** Runs inside Claude Code as a mod, reads exact usage, draws suggestions above the prompt and a receipt line under each answer. Receipts here can be verified.
- **Hook command.** A small command that agent hook systems call with JSON on standard input. It answers with allow, ask, a warning, or stop when the user has chosen stop. Used first for GitHub Copilot hooks in VS Code, later for Codex.
- **VS Code extension.** Installs the hook file with the user's consent, keeps keys in VS Code secret storage, and shows the counter, buttons and receipt. GitHub Copilot does not give hooks or extensions exact token counts, so Copilot receipts are estimates.

## Failure behaviour

Suggestions are advice. If a decision model times out, a key is missing or the machine is offline, twosystems stays silent and records the moment as not evaluated. It never blocks the user's work because of its own failure.

## Privacy

Only the short summary sent to System 1 leaves the machine, after a redaction pass for secrets, and the same summary goes to System 2 if the user switches it on. A local decision model with System 2 off keeps everything on the machine. Event logs stay local.
