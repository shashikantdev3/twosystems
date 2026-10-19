# Changelog

All notable changes to twosystems are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-alpha.2] - 2026-10-19

npm `twosystems` 0.1.0-alpha.2, PyPI `twosystems` 0.1.0a2, and the first Claude Code plugin.

### Added (Sprint 2: Claude Code plugin)

- The twosystems plugin for Claude Code, a mod that runs inside Claude Code with no Node.js (needs Claude Code 2.1.303 or newer). Install: `/plugin install twosystems --marketplace shashikantdev3/twosystems`.
- Stuck check through Claude Code's own permission dialog, only in the permission modes that show it: Yes lets the step run, No stops so the user can tell Claude what to try instead. An answer is recorded only once Claude Code reports that its dialog appeared and no other hook answered it (checked in a live terminal session).
- Fresh-start band above the prompt with Clear, Compact and Keep going (terminal and Desktop app; a pane in VS Code), after a turn in a large conversation and after an idle spell longer than the prompt cache lifetime.
- A prompt typed in the terminal that looks like a new task in a large conversation is held until the user chooses Clear then send, Compact then send, Send as is, or Edit (can be switched off). It is sent as the user's own words. It is never dropped: it goes back into the prompt box after any draft, or keeps waiting in the band when the box is busy.
- Exact usage for every main-loop request and every compaction, a receipt line under the next answer after twosystems did something, a status line entry, and `/twosystems` with the settings and the receipt.
- Settings in `/config`: engine, OpenRouter key (in secure storage), model, Ollama address, false-alarm level, holdout, cache lifetime, prompt holding, receipt line and timeout.
- A marketplace file at the repository root, and a CI job that runs `claude plugin validate --strict` and `claude plugin test` on Linux and Windows.
- Decision record 0006: the plugin is a mod, with one event file per session.

### Changed

- The event log is now `~/.twosystems/events.jsonl` plus one file per session in `~/.twosystems/events.d/`. `twosystems receipt` and `doctor` read both and count each event once.
- The core's shared logic no longer touches Node: contract types, a plain-TypeScript SHA-256 (checked against node:crypto), ids, observations, record builders, the receipt text and messages moved into modules reachable from `portable.ts`. Engines take any fetch and the pipeline any timer. A test fails if anything reachable from `portable.ts` imports a Node module.
- `scripts/check-release.mjs` also checks the plugin's version.
- A suggestion recorded with reason `not_shown` (its moment passed before it could appear) is not counted as shown, but stays in the verified comparison as the random draw assigned it, so missed moments dilute the measured effect toward zero rather than tilt the comparison. The receipt shows how many there were (`Receipt.decisions.notShown`).
- `twosystems receipt` and `doctor` no longer stop when `events.d` is a file rather than a folder.

## [0.1.0-alpha.1] - 2026-10-19

First alpha: npm `twosystems` 0.1.0-alpha.1 and PyPI `twosystems` 0.1.0a1.

### Added (Sprint 1: core engine)

- Rule signals, computed locally for free: repeated failing command, repeated error, no file changed, many tool calls, large conversation, prompt cache probably expired, and a new prompt that looks like a different task.
- A short summary of the moment for the decision model, redacted for secrets (provider keys, tokens, private keys, connection strings, passwords, emails and long random strings) and capped at 2,400 characters. The event log stores only its hash.
- Decision engines: OpenRouter decisions API (Microsoft-Decision-1 by default, TypeSafe Jev), Ollama's local decisions endpoint (`/v1/systemone`), and a rules-only engine that needs no key.
- Two typed questions (stuck, fresh start) with stable hashes for `decisions.lock`; built-in cautious thresholds until a fitted lock exists; fitted thresholds used only for the engine and question they were fitted on.
- A 10% random holdout by default, and receipt maths: own cost, an estimate of context tokens not sent again, and a verified saving with a 95% bootstrap interval that is shown only when it clears zero.
- The `twosystems` command: `hook` (Claude Code, GitHub Copilot in VS Code, the Copilot CLI and Codex; for Copilot only the stuck check in this alpha), `receipt` and `doctor` (with `--live` for one real call per question). The hook always answers with valid JSON and exit code 0.
- Ready-made hook files in `packages/core/hooks/`: Claude Code, GitHub Copilot (one file for VS Code and the Copilot CLI) and Codex.
- Local session notes between hook calls, redacted, cut to 400 characters, changed under a short lock, and removed once unused for seven days.
- Tests for every module, a replay test over four recorded hook sessions, and a release workflow with trusted publishing to PyPI and npm.
- Decision record 0005: one hook command, with local session notes.

### Added (Sprint 0: foundations)

- Repository structure, README, license (Apache-2.0), NOTICE and citation file.
- Contributing guide, security policy, issue and pull request templates, CODEOWNERS.
- Architecture overview, first decision records and the sprint roadmap.
- JSON Schemas for the event log (`events.schema.json`) and `decisions.lock` (`decisions-lock.schema.json`), with valid and invalid examples.
- TypeScript core package with typed validators for both files (`validateEvent`, `validateEventsJsonl`, `validateLock`).
- Python package with the same validators and a `twosystems-calibrate validate` command.
- Contract tests in both languages that run the same shared examples.
- Continuous integration on Windows, macOS and Linux (Node 22 and 24; Python 3.10 to 3.14 on Linux, 3.10 and 3.14 on Windows and macOS).
- One strict rule set in both languages: RFC 3339 timestamps with a time zone and no leap seconds, plain UUIDs, no NaN or out-of-range numbers, a 16 KiB limit per event and 1 MiB per lock, and the same line splitting for event logs (Windows line endings and a leading byte order mark are accepted).
- 193 shared edge cases with the expected verdict and exact error messages (`schemas/examples/edge-cases.json`), run by both test suites.
- Hardened parsing in both languages: text must be well-formed Unicode, nesting is limited to 32 levels (checked in one pass before parsing, so deep input cannot crash Python), and repeated keys are rejected.
- Error messages are fixed sentences that never repeat a rejected value; field names other than short plain names are hidden.
- Repeated items in arrays are found with one equality rule and one linear check in both languages (ajv's built-in check skipped some duplicates, and jsonschema's compared every pair).
- Value limits: at most 4,096 values per event and 65,536 per lock, checked before the schema. For values built in code, shared objects count once per place and the text in strings and field names must also fit the size limit. The worst inputs within the limits take up to about a second in TypeScript and about 5 seconds in Python.
- `twosystems-calibrate validate` reads at most the size limit of a lock and 64 MiB of an events log, checks a log one line at a time, and prints at most 100 problems, so huge, endless or very broken files are reported quickly.
- `engine.model` and `engine.model_version` in a lock follow the same short-identifier rule as in events.
- The Python source archive leaves out the tests, which need the shared examples from the repository root.
- Invalid examples now state the field each one must be rejected at.
- Tighter privacy in the event schema: identifiers are short tokens without spaces, `reason` is a code, calibration parameters are numbers only.
- `parseJson`, `validateEventText` and `validateLockText` in the core; `parse_json`, `validate_event_text` and `validate_lock_text` in Python.
