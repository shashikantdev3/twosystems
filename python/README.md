# twosystems (Python)

Offline tools for calibrating and checking twosystems decisions, published on PyPI as `twosystems`.

**Status:** planned for Sprints 1 and 3. See the [roadmap](../docs/roadmap.md).

## Planned commands

The command is `twosystems-calibrate`, so it does not clash with the `twosystems` command installed from npm.

- `twosystems-calibrate label`: find candidate moments in your local sessions and label them quickly.
- `twosystems-calibrate fit`: calibrate decisions and write `decisions.lock` with a bounded false-alarm rate.
- `twosystems-calibrate check`: replay a labelled set and fail on drift or a model version change.
- `twosystems-calibrate report`: an HTML report of decisions and savings.

Part of [twosystems](../README.md), created by Shashikant.
