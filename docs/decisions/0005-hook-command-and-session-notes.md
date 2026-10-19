# 0005: One hook command, with local session notes

**Status:** Accepted, 19 October 2026

## Context

Claude Code, GitHub Copilot (VS Code agent hooks and the Copilot CLI) and Codex can all run a command at fixed moments: when a prompt is sent, before and after each tool call, and when a turn ends. The command reads JSON on standard input and may answer with JSON. In October 2026 they use two payload styles: snake_case fields with the event name inside (Claude Code, VS Code, Codex) and camelCase fields with the event name set in the hook configuration (Copilot CLI). Each call is a new process, so nothing is remembered between calls unless it is written down. Hooks do not report token usage, except that Claude Code's transcript file records it.

## Decision

- One command, `twosystems hook --agent <name> [--event <name>]`, reads both payload styles and answers in the shape each agent expects.
- It always prints valid JSON and exits with code 0. Any problem of its own is written to `~/.twosystems/twosystems.log` and the agent carries on. The Copilot CLI treats a failing pre-tool hook as a refusal, so this rule protects the user's work.
- The stuck check runs before a tool call, at most once every five tool calls, and only tool calls since the last check count as evidence. When it is confident, it asks the user before the next step (`permissionDecision: "ask"`), and the user allows the step or denies it.
- The fresh-start check runs when a prompt is sent. When it is confident, it shows a note that does not block anything and suggests clearing or compacting before the next prompt. A `/clear` in the same project folder within 15 minutes, or a manual `/compact` in the same session, is recorded as the user taking the suggestion; automatic compaction is not. Where the note may not be shown (Copilot, for now), the check does not run at all, so no unseen suggestion is counted or paid for.
- Between calls, the command keeps short session notes in `~/.twosystems/sessions/`: the last 80 prompts, commands and errors, each redacted for secrets and cut to 400 characters, plus counters. Each change happens under a short lock, because agents run hooks in parallel; the decision model is called outside the lock. Notes unused for seven days are removed, checked once a day.
- The conversation size comes from the agent when it reports one, else from the last usage entry in a Claude Code transcript, else from a rough estimate (characters divided by four), which is labelled as an estimate in the event log.
- With no key, the rules engine decides and nothing leaves the machine. Until a fitted `decisions.lock` exists, built-in thresholds apply; they are cautious guesses and are labelled as not fitted.

## Consequences

- One adapter covers four agents, and new agents with similar hooks need only a payload mapping.
- The session notes keep a little redacted text on disk. They never leave the machine and are listed in the privacy section of the README.
- The Copilot CLI ignores replies to prompt hooks, and VS Code and the CLI read the same hook folders, so one hook file serves both and the two cannot be told apart reliably. In the alpha, only the stuck check runs for Copilot; the fresh-start note will be switched on for VS Code after a live test shows it.
- Copilot sessions have estimated sizes only, so their receipts are estimates.
- The Claude Code transcript is not a stable interface; reading it is best effort and fails quietly.
- A fresh-start note arrives with the prompt that triggered it, so it can save tokens only from the next prompt on. The Claude Code plugin in Sprint 2 can offer the choice before the prompt is sent.
