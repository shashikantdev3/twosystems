# twosystems

**A cheap, honest watchman for AI coding agents.** It will notice when your agent is stuck or when your work has moved on, suggest a better next step, and show what that saved, measured with a real before-and-after comparison instead of a guess.

Created and maintained by **[Shashikant](https://github.com/shashikantdev3)**.

> **Status: early development.** Nothing is published yet. Plans and progress are in [docs/roadmap.md](docs/roadmap.md). Star or watch the repository to follow along.

## The problem

AI coding agents such as Claude Code, GitHub Copilot and Codex send the whole conversation to the model on every request, and every tool call is another request. Claude Code's own documentation notes that a one-line question in a session that has been open all day still draws usage for the whole conversation, re-read at the cheaper cached rate, and that the first message after a break longer than the cache lifetime reprocesses the full context.[^1]

Two habits fix most of this: start fresh when you switch to unrelated work, and stop an agent that is going in circles. Both are easy to forget mid-task.

Many tools promise to cut tokens, but a tool's own counter is not your bill. In one independent test of 1,740 runs, rtk, a popular output compressor, counted 349 million tokens saved on its DeepSeek runs, yet cost per task did not fall: it stayed about the same with Claude Code and rose 17% with DeepSeek.[^2] A savings number is only useful if it has been checked.

## What twosystems will do

1. **Stuck check.** When the agent keeps hitting the same error, edits the same files and the tests do not move, twosystems will pause and ask you: stop, add a hint, or continue. You decide how rare a false alarm must be.
2. **Fresh-start check.** When a new prompt looks unrelated to the work in the session, or you come back after the cache has expired, it will show what continuing would cost compared with clearing or compacting, and let you choose.
3. **Honest receipt.** It will report estimated savings, the tokens spent recovering context that was dropped, and a verified figure. The verified figure comes from a small random holdout: for about one moment in ten, twosystems stays silent on purpose, so results with and without it can be compared.

## How it decides

The name comes from the idea of two kinds of thinking, a fast one and a slow one.

- **Plain rules** watch every turn on your machine, for free.
- **System 1** is a small decision model, such as Microsoft-Decision-1, Jev, or an open model running locally. It is asked only when the rules see something suspicious, and it returns a probability rather than text. At OpenRouter's listed price ($0.042 per million input tokens, output free), a typical decision of about 3,000 tokens is estimated at about a hundredth of a cent. It never uses your Claude or Copilot plan.
- **System 2** is a larger language model that can be switched on for the cases System 1 is unsure about. It is off by default.
- **You** have the final say. In v1, twosystems never acts on its own: it shows a suggestion with buttons, and stops the agent only when you choose stop.

Thresholds are calibrated on labelled examples, so that "confident" means something measurable, and they are stored in a `decisions.lock` file so that a model update cannot quietly change behaviour.

## Where it will run

| Channel | What ships there | Status |
|---|---|---|
| Claude Code plugin marketplace | Plugin with all three checks and the verified receipt | Planned for v1 |
| VS Code Marketplace | Extension for GitHub Copilot users, plus a receipt view for Claude Code in VS Code | Planned for v1 |
| Open VSX | The same extension for Cursor and Windsurf | Planned for v1 |
| npm | The TypeScript core and the `twosystems` command (`hook`, `receipt`, `doctor`) | Planned for v1 |
| PyPI | Calibration and reporting tools, run as `twosystems-calibrate` (`label`, `fit`, `check`, `report`) | Planned for v1 |
| Codex | Hooks support | Planned for v1.1 |

## Honest limits

- It cannot change token use inside the ChatGPT or Claude.ai web apps.
- GitHub Copilot does not give hooks or extensions exact token counts, so receipts for Copilot sessions will be estimates. Claude Code receipts can be verified.
- It does not trim tool output. One independent test found that this kind of saving did not lower cost per task.
- Savings depend on how you work. Long sessions and frequent task switching benefit most; short, single-task sessions benefit very little.

## Privacy

Everything is logged locally, in `~/.twosystems/`. The only data that leaves your machine is a short summary of the moment being judged (a few thousand tokens at most, after a redaction pass for secrets), sent to the decision model you configure and, if you switch it on, to System 2. With a local model and System 2 off, nothing leaves your machine.

## Repository layout

```
packages/core/         TypeScript core: signals, decision engines, receipt maths, the twosystems command (npm)
packages/claude-code/  Claude Code plugin
packages/vscode/       VS Code extension (VS Code Marketplace and Open VSX)
python/                Python package: labelling, calibration, drift checks, reports (PyPI, twosystems-calibrate)
schemas/               Shared file formats: the event log and decisions.lock
docs/                  Architecture, decision records and roadmap
```

## Roadmap

[docs/roadmap.md](docs/roadmap.md) has the sprint plan from the first commit to release on every channel. [docs/architecture.md](docs/architecture.md) explains how the parts fit together.

## Contributing

Ideas, bug reports and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Citing

If you use twosystems in research or write about it, please cite it using [CITATION.cff](CITATION.cff). GitHub shows a "Cite this repository" button for it.

## Author

twosystems is designed and built by **Shashikant**, an applied AI engineer. GitHub: [@shashikantdev3](https://github.com/shashikantdev3).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Under section 4(d) of the license, anyone distributing a derivative work must carry the attribution notices in NOTICE.

[^1]: Claude Code documentation, "Manage costs effectively": https://code.claude.com/docs/en/costs
[^2]: Quesma, "Does RTK make AI coding cheaper?", 11 September 2026: https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/
