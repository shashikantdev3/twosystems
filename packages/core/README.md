# twosystems

**A cheap, honest watchman for AI coding agents.** twosystems notices when your agent is stuck in a loop or when a fresh start would save tokens, asks a small decision model only when plain rules see something suspicious, and keeps a receipt of what it cost and what it saved.

Created and maintained by **[Shashikant](https://github.com/shashikantdev3)**. Apache License 2.0.

> **Alpha (0.1.0-alpha.1).** The engine, the `twosystems` command and the hook adapters are built and tested against recorded hook payloads. They have not yet been used for long in real sessions, and the thresholds are cautious defaults, not fitted on data. Expect changes. Feedback and issues are welcome: https://github.com/shashikantdev3/twosystems/issues

## What it does

- **Stuck check.** When the agent runs the same failing command or meets the same error again and again, twosystems asks you before its next step. Allow the step to keep going, or deny it and give the agent a hint.
- **Fresh-start check.** When the conversation is large, the prompt cache has probably expired, or a new prompt looks like a different task, it shows a note suggesting `/clear` or `/compact` (or a new chat) before your next prompt.
- **Receipt.** `twosystems receipt` reports what it did, its own cost, an estimate of tokens saved (labelled as one), and a verified saving from a random holdout once there is enough data.

It never acts on its own and never blocks your work because of its own failure: if the model is slow, a key is missing or you are offline, it stays silent and records the moment.

## Install

Node.js 22 or newer.

```bash
npm install --global twosystems@alpha
twosystems doctor
```

## Connect it to your agent

Hooks call `twosystems hook`. Ready-made hook files are in the package's [`hooks/`](https://github.com/shashikantdev3/twosystems/tree/main/packages/core/hooks) folder.

| Agent | Where the hooks go | File to copy | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` (or the project's `.claude/settings.json`), under `"hooks"` | `hooks/claude-code.json` | Conversation size is read from the session transcript |
| GitHub Copilot (VS Code agent hooks and the Copilot CLI) | `.github/hooks/twosystems.json` in your project, or `~/.copilot/hooks/twosystems.json` for all projects (not both) | `hooks/copilot.json` | VS Code and the CLI read the same folders, so one file serves both. Hooks are a VS Code preview feature; sizes are estimates. In this alpha only the stuck check runs for Copilot: the CLI drops replies to prompt hooks, and the fresh-start note will be switched on for VS Code after a live test |
| Codex | `~/.codex/hooks.json`, then approve it with `/hooks` | `hooks/codex.json` | Not yet tried against a live Codex session |

## Choose how it decides

| Engine | Set | What leaves your machine |
|---|---|---|
| Rules only (default without a key) | nothing | Nothing |
| Microsoft-Decision-1 or TypeSafe Jev on OpenRouter | `OPENROUTER_API_KEY`, and optionally `TWOSYSTEMS_MODEL=typesafe/jev-1.14` | A short summary of the moment (about 600 tokens at most), redacted for secrets |
| A local decision model in Ollama 0.35+ (for example `nimble`, `clef-flash`, `tev1:4b`) | `TWOSYSTEMS_ENGINE=ollama`, `TWOSYSTEMS_MODEL=nimble` | Nothing, unless Ollama runs elsewhere or you use a `:cloud` model |

At OpenRouter's listed price on 19 October 2026 ($0.042 per million input tokens, output free), one decision costs about $0.00003. Decisions run only when a rule fires, and never use your Claude or Copilot plan.

Other settings: `TWOSYSTEMS_HOLDOUT` (default 0.1), `TWOSYSTEMS_TIMEOUT_MS` (default 3000, at most 10000), `TWOSYSTEMS_CACHE_TTL_S` (default 3600 for Claude Code on a Claude plan, 300 otherwise), `TWOSYSTEMS_HOME` (default `~/.twosystems`), `TWOSYSTEMS_LOCK`, `OLLAMA_HOST`. Run `twosystems --help` for the full list, and `twosystems doctor --live` to try the decision model once.

## Privacy

- The event log (`~/.twosystems/events.jsonl`) holds no prompts, code or file contents: only decisions, sizes, costs and a hash of what was judged.
- Short session notes (recent prompts, commands and errors, redacted and cut to 400 characters) are kept in `~/.twosystems/sessions/` so the checks can see the last few steps. They never leave your machine and are removed once unused for seven days (checked once a day while hooks run).
- With a remote engine, only the redacted summary of the moment is sent, to the provider you chose.

## Use it from code

```ts
import { evaluate, RulesEngine, builtInLock } from "twosystems";

const engine = new RulesEngine();
const result = await evaluate({
  name: "stuck",
  observations, // prompts, tool calls and context sizes, in time order
  now: Date.now(),
  engine,
  lock: builtInLock(engine.info),
  holdoutRate: 0.1,
  timeoutMs: 3000,
  cacheTtlSeconds: 300,
  agent: "other",
  session: "my-session",
});
// result.show is "pause", "clear" or "compact" when a suggestion should be shown.
```

Also exported: the validators for the shared file formats (`validateEvent`, `validateEventsJsonl`, `validateLock`, `parseJson`), the engines, `buildReceipt`, `redact`, and the JSON Schemas as `twosystems/schemas/*`.

## Links

- Source, roadmap and design notes: https://github.com/shashikantdev3/twosystems
- The calibration tools (Python): https://pypi.org/project/twosystems/

Built by Shashikant. If twosystems helps you, a star on GitHub helps others find it.
