# Contributing to twosystems

twosystems is created and maintained by Shashikant ([@shashikantdev3](https://github.com/shashikantdev3)). The project is in early development, so the most useful contributions right now are ideas, questions and reports of how your agent sessions waste tokens.

## Before you start

- Read the [README](README.md), the [architecture](docs/architecture.md) and the [roadmap](docs/roadmap.md).
- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Changes to the shared file formats in `schemas/` always need an issue first, because every adapter depends on them.

## Ground rules

- **Honest numbers.** Never present an estimate as a measured saving. Label estimates as estimates.
- **Never spend the user's plan silently.** Anything that calls a model must respect the cost rule in the architecture document.
- **Privacy first.** Nothing leaves the user's machine except the short, redacted summary sent to the configured decision model and, if the user switches it on, to System 2.
- **Fail silent.** If twosystems cannot decide, it does nothing and records the moment as not evaluated.

## Development setup

You need Node.js 22 or newer and [uv](https://docs.astral.sh/uv/), and for the Claude Code plugin, Claude Code 2.1.303 or newer.

```
# TypeScript core
npm ci
npm run build
npm test

# Python package
cd python
uv sync
uv run pytest
uv run ruff check .
uv run ruff format --check .

# Claude Code plugin (from the repository root)
claude plugin validate --strict .
claude plugin validate --strict packages/claude-code
claude plugin test packages/claude-code
```

The JSON Schemas in `schemas/`, plus `LICENSE` and `NOTICE`, are the single source of truth. Each package keeps a copy so it can be published on its own. After changing any of them, run `npm run sync` and commit the copies; CI fails if they differ.

The Claude Code plugin carries a copy of the portable core in `packages/claude-code/hooks/core/`. After changing anything that `packages/core/src/portable.ts` reaches, run `npm run sync` too. Never edit the copy itself.

To try the plugin in a session, run `claude --plugin-dir packages/claude-code`; saving a file reloads it. The VS Code extension arrives in Sprint 4.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(core): add idle-time signal` or `docs: explain the holdout`.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
