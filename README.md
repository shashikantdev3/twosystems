# twosystems

**A cheap, honest watchman for AI coding agents.** It will notice when your agent is stuck or when your work has moved on, suggest a better next step, and show what that saved, measured with a real before-and-after comparison instead of a guess.

Created and maintained by **[Shashikant](https://github.com/shashikantdev3)**.

[![ci](https://github.com/shashikantdev3/twosystems/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikantdev3/twosystems/actions/workflows/ci.yml)

> **Status: alpha (Sprint 3).** The Claude Code plugin runs all three checks inside Claude Code, and the `twosystems` command works with GitHub Copilot and Codex hooks. Both are tested, but not yet in long real use. The calibration kit is built: you can fit thresholds on your own labelled sessions. The thresholds twosystems ships are still cautious defaults until they are fitted on about 300 labelled moments. Plans and progress are in [docs/roadmap.md](docs/roadmap.md). Star or watch the repository to follow along.

## The problem

AI coding agents such as Claude Code, GitHub Copilot and Codex send the whole conversation to the model on every request, and every tool call is another request. Claude Code's own documentation notes that a one-line question in a session that has been open all day still draws usage for the whole conversation, re-read at the cheaper cached rate, and that the first message after a break longer than the cache lifetime reprocesses the full context.[^1]

Two habits fix most of this: start fresh when you switch to unrelated work, and stop an agent that is going in circles. Both are easy to forget mid-task.

Many tools promise to cut tokens, but a tool's own counter is not your bill. In one independent test of 1,740 runs, rtk, a popular output compressor, counted 349 million tokens saved on its DeepSeek runs, yet cost per task did not fall: it stayed about the same with Claude Code and rose 17% with DeepSeek.[^2] A savings number is only useful if it has been checked.

## What twosystems does

1. **Stuck check.** When the agent keeps running the same failing command or meeting the same error, twosystems asks you before its next step: allow it to keep going, or deny it and give the agent a hint. Calibration lets you decide how rare a false alarm must be.
2. **Fresh-start check.** When a new prompt looks unrelated to the work in the session, the conversation is large, or you come back after the cache has expired, it suggests clearing or compacting and lets you choose.
3. **Honest receipt.** It reports its own cost, estimated savings, and a verified figure. The verified figure comes from a small random holdout: for about one moment in ten, twosystems stays silent on purpose, so results with and without it can be compared. Recovery cost (tokens spent rebuilding context after a fresh start) is planned for Sprint 5.

## Try the alpha

**Claude Code** (terminal and Desktop app; VS Code extension with a pane in place of the band; Claude Code 2.1.303 or newer), at the Claude Code prompt:

```
/plugin install twosystems --marketplace shashikantdev3/twosystems
```

The [plugin README](packages/claude-code/README.md) covers settings, what you will see and how to remove it. `/twosystems` shows the receipt.

**GitHub Copilot and Codex** (Node.js 22 or newer):

```bash
npm install --global twosystems@alpha
twosystems doctor
```

Then add the hook file for your agent from [`packages/core/hooks/`](packages/core/hooks/): GitHub Copilot (VS Code and the Copilot CLI share one file; stuck check only in this alpha) or Codex. The [package README](packages/core/README.md) explains where each file goes and how to choose the decision model. `twosystems receipt` shows what it did.

## How it decides

The name comes from the idea of two kinds of thinking, a fast one and a slow one.

- **Plain rules** watch every turn on your machine, for free.
- **System 1** is a small decision model, such as Microsoft-Decision-1, Jev, or an open model running locally. It is asked only when the rules see something suspicious, and it returns a probability rather than text. At OpenRouter's listed price ($0.042 per million input tokens, output free), a decision of under 1,000 tokens costs about $0.00003. It never uses your Claude or Copilot plan.
- **System 2** is a larger language model that can be switched on for the cases System 1 is unsure about. It is off by default.
- **You** have the final say. twosystems never acts on its own: it shows a suggestion, and the agent stops only when you choose to stop it.

Thresholds can be calibrated on labelled moments from your own sessions, so that "confident" means something measurable: `twosystems moments` finds the moments in your saved Claude Code sessions, `twosystems-calibrate label` asks one key per moment, and `twosystems-calibrate fit` writes a `decisions.lock` chosen so that, with 95% confidence, no more than 5% of its interruptions are wrong (both numbers are yours to set). The guarantee assumes your labelled moments are a fair sample of the moments to come; moments from one session are alike, so treat it as a little optimistic. A lock is used only with the engine and question wording it was fitted for, and not when the model reports a version other than the one it was fitted on (when either side gives no version, the lock is used); anything else falls back to the built-in thresholds and is logged as a mismatch. After a model update, `twosystems-calibrate check` tells you whether the answers drifted. See the [Python package](python/README.md). Until you fit your own, cautious built-in thresholds apply.

## Where it will run

| Channel | What ships there | Status |
|---|---|---|
| Claude Code (this repository's marketplace) | Plugin with all three checks and receipts from exact token counts | Alpha (Sprint 2) |
| VS Code Marketplace | Extension for GitHub Copilot users, plus a receipt view for Claude Code in VS Code | Planned for v1 |
| Open VSX | The same extension for Cursor and Windsurf | Planned for v1 |
| npm | The TypeScript core and the `twosystems` command (`hook`, `receipt`, `doctor`, `moments`) | Alpha |
| PyPI | Calibration and reporting tools, run as `twosystems-calibrate` (`validate`, `label`, `fit`, `check`, `report`) | Alpha |
| Codex | Hooks support through the `twosystems` command | Alpha, untested with a live session |

## Honest limits

- It cannot change token use inside the ChatGPT or Claude.ai web apps.
- GitHub Copilot does not give hooks or extensions exact token counts, so receipts for Copilot sessions will be estimates. Claude Code receipts can be verified.
- It does not trim tool output. One independent test found that this kind of saving did not lower cost per task.
- Savings depend on how you work. Long sessions and frequent task switching benefit most; short, single-task sessions benefit very little.

## Privacy

Everything is logged locally, in `~/.twosystems/` (the Claude Code plugin writes one file per session in `~/.twosystems/events.d/`). The event log holds no prompts or code, only decisions, sizes, costs and a hash of what was judged. The hook command's short session notes (recent prompts, commands and errors, redacted and cut to 400 characters) stay in `~/.twosystems/sessions/` and are removed once unused for seven days (checked once a day while hooks run). The only data that leaves your machine is a short summary of the moment being judged (about 600 tokens at most, after a redaction pass for secrets), sent to the decision model you configure and, if you switch it on, to System 2. With the rules engine or a local model, nothing leaves your machine. For calibration, `twosystems moments` writes `~/.twosystems/moments.jsonl` (readable by you only), which holds redacted text from your saved sessions so you can label them; it is built from files already on your machine and stays there unless you score moments with a remote decision model, which then receives each moment's short summary exactly as a live check would.

## Repository layout

```
packages/core/         TypeScript core: signals, decision engines, receipt maths, the twosystems command (npm)
packages/claude-code/  Claude Code plugin (a mod; installs from .claude-plugin/marketplace.json)
packages/vscode/       VS Code extension (VS Code Marketplace and Open VSX)
python/                Python package: labelling, calibration, drift checks, reports (PyPI, twosystems-calibrate)
schemas/               Shared file formats: the event log, decisions.lock and moments.jsonl
docs/                  Architecture, decision records and roadmap
```

## Roadmap

[docs/roadmap.md](docs/roadmap.md) has the sprint plan from the first commit to release on every channel. [docs/architecture.md](docs/architecture.md) explains how the parts fit together.

## Contributing

Ideas, bug reports and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; it also explains how to build and test from source.

## Citing

If you use twosystems in research or write about it, please cite it using [CITATION.cff](CITATION.cff). GitHub shows a "Cite this repository" button for it.

## Author

twosystems is designed and built by **Shashikant**, an applied AI engineer. GitHub: [@shashikantdev3](https://github.com/shashikantdev3).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Under section 4(d) of the license, anyone distributing a derivative work must carry the attribution notices in NOTICE.

[^1]: Claude Code documentation, "Manage costs effectively": https://code.claude.com/docs/en/costs
[^2]: Quesma, "Does RTK make AI coding cheaper?", 11 September 2026: https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/
