# 0001: One TypeScript core with thin adapters

**Status:** Accepted, 18 October 2026

## Context

twosystems must run inside Claude Code, inside VS Code alongside GitHub Copilot, and inside forks of VS Code such as Cursor and Windsurf. Claude Code plugins (mods) and VS Code extensions both run JavaScript. Calibration and reporting are data work, where Python is the better fit.

## Decision

The runtime logic (signals, decision engines, bands, holdout, receipt maths) is written once as a TypeScript library and bundled into each adapter. Offline work (labelling, fitting, drift checks, reports) lives in a Python package. The two sides share only files with published schemas.

## Consequences

- One implementation of the runtime rules, so the adapters cannot drift apart.
- Two languages to maintain, kept apart by clear file contracts.
- The core is also published on npm, which gives other tools a way to reuse it.
