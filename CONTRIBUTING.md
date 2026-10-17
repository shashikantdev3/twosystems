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

The toolchain arrives in Sprint 0 and Sprint 1. This section will describe how to install dependencies, run the tests and load the Claude Code plugin and VS Code extension locally.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(core): add idle-time signal` or `docs: explain the holdout`.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
