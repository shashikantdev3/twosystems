# 0003: Verified savings come from a randomized holdout

**Status:** Accepted, 18 October 2026

## Context

Most token-saving tools report savings from their own counters, such as bytes removed. One independent matched test (Quesma, September 2026) found a counter reporting hundreds of millions of tokens saved while cost per task did not fall. The same task can also vary widely in tokens from run to run, so a single before-and-after comparison proves little.

## Decision

For each eligible moment, twosystems decides at random whether to act or to stay silent, with about 10% silent. Costs after acting and after staying silent are compared, with a bootstrap confidence interval. The receipt shows a verified figure only when that interval clears zero. Estimates are always labelled as estimates.

## Consequences

- Numbers that can be defended in public.
- About one useful suggestion in ten is withheld on purpose. Users can turn the holdout off, in which case the receipt shows estimates only.
- Verified figures need weeks of real use before they appear.
