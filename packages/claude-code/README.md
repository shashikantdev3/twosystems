# twosystems for Claude Code

**A cheap, honest watchman inside Claude Code.** It asks before the next step when the agent seems stuck, suggests `/clear` or `/compact` when a fresh start would save tokens, and keeps a receipt of what it cost and what it saved, from Claude Code's exact token counts.

Created and maintained by **[Shashikant](https://github.com/shashikantdev3)**. Apache License 2.0.

> **Alpha (0.1.0-alpha.3).** Built and tested with Claude Code 2.1.303's plugin test kit, and checked with real model requests, but not yet used for long in daily work. Thresholds are cautious defaults until you fit your own (see Settings). Feedback and issues: https://github.com/shashikantdev3/twosystems/issues

## Install

At the Claude Code prompt in a terminal:

```
/plugin install twosystems --marketplace shashikantdev3/twosystems
```

Answer `y` to add the marketplace, then pick a scope (user scope runs it in every project). Or from a shell:

```
claude plugin install twosystems --marketplace shashikantdev3/twosystems
```

In the Desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `shashikantdev3/twosystems`, then Add plugin.

It runs inside Claude Code as a mod, so no Node.js or npm install is needed. It needs Claude Code 2.1.303 or newer, the version it is built and tested with. The band above the prompt draws in the terminal and the Desktop app; in the VS Code extension the same suggestion opens in a pane instead (not yet tried in a live VS Code session).

If you set up the `twosystems hook` command in `settings.json` earlier, remove those hooks: this plugin does the same job, and with both you may be asked twice. The plugin tells you if it finds them.

## What you will see

- **Stuck check.** Plain rules look at every tool call for the same failing command, the same error, no file changing, or a very long run. When they fire, the decision model (or the rules alone) is asked, at most once every five tool calls in the conversation or in each subagent. When it is confident, Claude Code's own permission dialog asks before the next step. *Yes* lets it run. *No* stops there, and you can tell Claude what to try instead. This happens only in the default (manual), accept-edits and plan modes, where Claude Code shows its dialog; in auto, don't-ask and bypass modes twosystems stays silent rather than block a step. If the line under the prompt says auto mode, press shift+tab to switch when you want the stuck check.
- **Fresh-start band.** A band above the prompt with **Clear**, **Compact** and **Keep going**, when the conversation has grown large, or when you come back after the prompt cache has probably expired (so the next prompt would re-send the whole conversation at full price). Click a button, or press ctrl+x tab to focus the band and then the letter shown (c, m, k).
- **New task, large conversation.** When a prompt you type in the terminal looks like a different task and the conversation is large, the prompt waits and the band offers **Clear, then send**, **Compact, then send**, **Send as is** or **Edit** (s, e). A held prompt is sent as your own words. It is not dropped: if you type `/clear`, `/compact` or another prompt instead, or `/resume`, it goes back into the prompt box after anything you typed there; if the box is busy, it stays waiting in the band. In the Desktop app and VS Code prompts are not held (the band, or the pane in VS Code, still appears there). Prompts with `@` mentions or pasted images are never held. Checking a prompt can make Enter wait up to the decision model timeout (5 seconds by default), and only when the rules already see a large conversation and a change of topic. You can switch holding off.
- **Receipt.** A short line under the next answer when twosystems did something (and once after a fresh start, how much smaller each request became), a status line entry, and `/twosystems` for the full receipt: checks run, suggestions shown and taken, its own cost, an estimate of tokens not re-sent, and a verified saving once the random holdout has enough data.

twosystems never acts on its own. Its suggestions add nothing to Claude's context: the band, the pane, the status line and the line under an answer are shown to you only. A held prompt reaches Claude exactly as you typed it, and `/twosystems` output lands in the transcript as any command's output does. If the decision model is slow, a key is missing or you are offline, it stays silent and records the moment. In `claude -p` and the Agent SDK, where nobody sees a dialog, it never asks and only records usage.

**Honest counting.** A suggestion is counted as shown only when it really appeared: a stuck question only once Claude Code reported its dialog and no other hook answered it, a band only when it could be drawn. A moment that passed before its suggestion could appear is recorded as "not shown". It still stays in the comparison that measures savings, on the side the random draw put it, because dropping it from one side only would tilt the result. Missed moments dilute the measured effect toward zero; they do not tilt the comparison.

**Where an organization manages Claude Code**, some events do not reach plugins a person installs. There, the stuck check stays silent (twosystems cannot see the permission mode, so it does not guess), and a `/compact` you type or an automatic compaction is neither counted as taking a suggestion nor recorded as cost; only the band's own Compact records its cost. The band, the held prompt and the usage of every normal request still work.

## Settings

Run `/config` and look for the twosystems rows, or set them when you install:

| Setting | Default | What it does |
|---|---|---|
| Decision engine | auto | `auto` uses OpenRouter when a key is set, otherwise rules. `rules` keeps everything on your machine. `openrouter` uses Microsoft Decision-1 (default) or TypeSafe Jev. `ollama` uses a local decision model. |
| OpenRouter API key | empty | Kept in your system's secure storage. Empty uses `OPENROUTER_API_KEY` from your environment, if set. |
| Decision model | empty | Empty for the default. For example `typesafe/jev-1.14`, or an Ollama model such as `nimble`. |
| Ollama address | `http://127.0.0.1:11434` | For the `ollama` engine. |
| False-alarm level | low | How readily it interrupts. It moves the built-in thresholds (medium lowers them by 0.05, high by 0.10); it is not a measured rate. Not used once you fit your own thresholds (below). |
| Holdout share | 0.1 | Share of suggestions held back on purpose, so the receipt can measure what the shown ones saved. |
| Prompt cache lifetime | 60 minutes | 60 on a Claude plan, 5 with an API key or a cloud provider. |
| Ask before a new task in a large conversation | on | Holds such a prompt until you choose. |
| Receipt line under answers | on | |
| Decision model timeout | 5000 ms | |

**Your own thresholds.** If `~/.twosystems/decisions.lock` exists (written by `twosystems-calibrate fit` from moments you labelled), the plugin uses it from its next start instead of the built-in thresholds, and `/twosystems` says per decision whether it applies. A decision the lock does not cover, or one fitted for another engine or question wording, keeps the built-in thresholds, and so does a check whose model reports a version other than the one the lock was fitted on. See [calibrating on your own sessions](https://github.com/shashikantdev3/twosystems/blob/main/python/README.md).

At OpenRouter's listed price ($0.042 per million input tokens, output free), one decision costs about $0.00001 to $0.00003, and decisions run only when a rule fires.

## Privacy

- Records go to `~/.twosystems/events.d/` (on Windows, under your user profile folder), in small files per session, in the same format as the `twosystems` command's `events.jsonl`. They hold no prompts, code or file contents: only decisions, token counts, costs and a hash of what was judged. `twosystems receipt` in a terminal reads both.
- Recent prompts, commands and errors are kept in memory while the session runs, redacted and cut to 400 characters, and never written to disk by the plugin.
- With a remote engine, only a short summary of the moment (redacted for secrets, about 600 tokens at most) goes to the provider you chose, through Claude Code's own network access. Other mods you install can see requests made that way, including the key's header, so install only mods you trust.
- Before installing, `claude plugin validate` on a copy of this folder lists every event the plugin hooks, every call it makes, and every environment variable it reads (`HOME`, `USERPROFILE`, `TWOSYSTEMS_HOME`, `OPENROUTER_API_KEY`).

## Remove it

`/plugin`, then the Installed tab, then twosystems, then Uninstall. Delete `~/.twosystems/` too if you want the records gone.

## For developers

The plugin is a Claude Code mod: `hooks/register.tsx` is the hooks module, `hooks/plugin/` holds its parts, and `hooks/core/` is a copy of the portable part of `packages/core` (made by `npm run sync`; CI fails if it is out of date). From the repository root:

```
claude plugin validate --strict packages/claude-code
claude plugin test packages/claude-code
claude --plugin-dir packages/claude-code     # try it in a session
```

Part of [twosystems](https://github.com/shashikantdev3/twosystems), created by Shashikant.
