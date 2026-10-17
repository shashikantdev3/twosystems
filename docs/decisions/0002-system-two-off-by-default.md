# 0002: System 2 is off by default

**Status:** Accepted, 18 October 2026

## Context

A tool meant to save tokens must not spend the user's plan to do it. A larger model reviewing uncertain cases could draw on the same Claude or Copilot plan the user is trying to protect, if it ran on the agent's own model.

## Decision

By default, when System 1 is unsure, twosystems stays silent or asks the user. System 2 can be switched on in settings. Suggestions are shown only in the interface and add nothing to the agent's context.

## Consequences

- Zero plan tokens used by twosystems in the default setup.
- Some uncertain cases go unflagged; the calibration report shows how many.
