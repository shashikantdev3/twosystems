# Roadmap

twosystems is built in short sprints, each about one week at an evenings-and-weekends pace. Every sprint ends with a review against its exit checks before anything is merged or published. Sprint lengths are targets, not promises.

**Current sprint:** 0 (structure, docs, file formats, toolchain and CI done; accounts in progress).

The two long poles are labelling real sessions for calibration and collecting enough real usage for the verified receipt. Both start early and run in the background from Sprint 2 onwards.

## Sprint 0: Foundations

**Goal:** a repository that anyone can understand and build on.

- Repository structure, README, license, NOTICE, citation file, contributing and security guides.
- Architecture overview and the first decision records.
- Shared contracts as JSON Schemas with examples: the event log (`events.jsonl`) and `decisions.lock`.
- Tooling: npm workspaces with TypeScript and Node's built-in test runner; uv with a Python project; continuous integration on Windows, macOS and Linux.
- Accounts: PyPI, Azure DevOps with a VS Code Marketplace publisher, Open VSX, and an OpenRouter test key.

**Exit checks:** CI passes; every schema example validates; the README and architecture match each other.

## Sprint 1: Core engine and first releases

**Goal:** the shared brain, usable from the command line.

- `packages/core`: event log, signals (repeated commands and errors, files changed, tests, context size, idle time against the cache lifetime), state builder with secret redaction, decision engines (OpenRouter decisions API, Ollama, none), decision bands read from `decisions.lock`, holdout assignment, receipt maths.
- Command line: `twosystems hook` (JSON in, JSON out, for agent hooks), `twosystems receipt`, `twosystems doctor`.
- First alpha releases with working code, which also secure the names: npm `twosystems` (the `twosystems` command) and PyPI `twosystems` (the `twosystems-calibrate` command).

**Exit checks:** unit tests for every module; a replay test over recorded events; one live call each to Microsoft-Decision-1 and Jev; no secrets in any logged state.

## Sprint 2: Claude Code plugin

**Goal:** the first real user experience, used daily by the author.

- Mod that listens to prompts, tool calls, finished turns and usage.
- Fresh-start check with a band above the prompt and buttons for clear, compact or keep going.
- Stuck check with stop, add a hint or continue.
- A one-line receipt under each answer and a `/twosystems` command.
- Settings for engine, key, false-alarm budget and holdout.
- Marketplace file at the repository root (`.claude-plugin/marketplace.json`, marketplace name `twosystems`, plugin source `./packages/claude-code`), so the plugin installs straight from GitHub.

**Exit checks:** `claude plugin validate --strict` and `claude plugin test` pass; installs from GitHub on a clean Windows machine; three days of daily use without errors.

## Sprint 3: Calibration kit (Python)

**Goal:** thresholds that mean what they say.

- `twosystems-calibrate label`: finds candidate moments in local Claude Code sessions and makes labelling them quick, with an optional model pre-label to confirm.
- `twosystems-calibrate fit`: calibrates each decision and picks thresholds with an upper bound on the false-alarm rate, then writes `decisions.lock`.
- `twosystems-calibrate check`: replays a labelled set and fails on drift or a model version change.
- `twosystems-calibrate report`: an HTML report of decisions and savings.
- About 300 labelled moments from the author's own sessions, used to ship default thresholds.

**Exit checks:** fitted thresholds hold on held-out data; fitting is reproducible from the same inputs.

## Sprint 4: VS Code extension and Copilot hooks

**Goal:** reach the many developers who use GitHub Copilot in VS Code.

- Extension that installs the hook file only after the user agrees, stores keys in VS Code secret storage, and shows a status bar counter, notifications with buttons, and a receipt view for both Copilot and Claude Code.
- Copilot hooks: the stuck check asks before the next tool call and stops the agent only when the user chooses stop; the fresh-start check shows a warning and offers a new chat.
- Packaged `.vsix`, tested with Copilot on Windows and with Cursor through Open VSX.

**Exit checks:** works on a fresh VS Code profile; uninstalling removes the hook file; Copilot receipts are clearly labelled as estimates.

## Sprint 5: Honest receipt and evaluation

**Goal:** savings numbers that survive scrutiny.

- The 10% holdout running in both adapters; confidence intervals by bootstrap; the verified figure appears only when the interval clears zero; our own overhead is subtracted.
- Privacy tests for redaction; behaviour checks for timeouts, missing keys and offline use.
- Documentation site and a written method for how savings are measured.

**Exit checks:** a complete receipt from the author's real usage, with intervals; all privacy tests pass.

## Sprint 6: Release v1.0

**Goal:** one version, installable from every channel.

- Release workflows: PyPI and npm through trusted publishing, VS Code Marketplace through `vsce`, Open VSX through `ovsx`, the Claude Code marketplace through a tagged version, and a GitHub Release with notes.
- Install tests on Windows, macOS and Linux following the README alone.
- Launch material: a short demo GIF, a write-up with the measured numbers, and a Hindi walkthrough on DevWithData.
- Optional: submission to Anthropic's plugin directory.

**Exit checks:** v1.0.0 installs from PyPI, npm, the VS Code Marketplace, Open VSX, the Claude Code marketplace and GitHub, following only the published instructions.

## After v1

- Codex hooks (v1.1).
- Reasoning-effort picker, shipped only if it beats existing routers on measured results.
- Tamper-evident decision records, based on the author's ProvenKit format.
- Gemini CLI and other agents as their hook systems allow.
