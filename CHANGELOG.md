# Changelog

All notable changes to twosystems are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Repository structure, README, license (Apache-2.0), NOTICE and citation file.
- Contributing guide, security policy, issue and pull request templates, CODEOWNERS.
- Architecture overview, first decision records and the sprint roadmap.
- JSON Schemas for the event log (`events.schema.json`) and `decisions.lock` (`decisions-lock.schema.json`), with valid and invalid examples.
- TypeScript core package with typed validators for both files (`validateEvent`, `validateEventsJsonl`, `validateLock`).
- Python package with the same validators and a `twosystems-calibrate validate` command.
- Contract tests in both languages that run the same shared examples.
- Continuous integration on Windows, macOS and Linux (Node 22 and 24; Python 3.10 to 3.14 on Linux, 3.10 and 3.14 on Windows and macOS).
- One strict rule set in both languages: RFC 3339 timestamps with a time zone and no leap seconds, plain UUIDs, no NaN or out-of-range numbers, a 16 KiB limit per event and 1 MiB per lock, and the same line splitting for event logs (Windows line endings and a leading byte order mark are accepted).
- 193 shared edge cases with the expected verdict and exact error messages (`schemas/examples/edge-cases.json`), run by both test suites.
- Hardened parsing in both languages: text must be well-formed Unicode, nesting is limited to 32 levels (checked in one pass before parsing, so deep input cannot crash Python), and repeated keys are rejected.
- Error messages are fixed sentences that never repeat a rejected value; field names other than short plain names are hidden.
- Repeated items in arrays are found with one equality rule and one linear check in both languages (ajv's built-in check skipped some duplicates, and jsonschema's compared every pair).
- Value limits: at most 4,096 values per event and 65,536 per lock, checked before the schema. For values built in code, shared objects count once per place and the text in strings and field names must also fit the size limit. The worst inputs within the limits take up to about a second in TypeScript and about 5 seconds in Python.
- `twosystems-calibrate validate` reads at most the size limit of a lock and 64 MiB of an events log, checks a log one line at a time, and prints at most 100 problems, so huge, endless or very broken files are reported quickly.
- `engine.model` and `engine.model_version` in a lock follow the same short-identifier rule as in events.
- The Python source archive leaves out the tests, which need the shared examples from the repository root.
- Invalid examples now state the field each one must be rejected at.
- Tighter privacy in the event schema: identifiers are short tokens without spaces, `reason` is a code, calibration parameters are numbers only.
- `parseJson`, `validateEventText` and `validateLockText` in the core; `parse_json`, `validate_event_text` and `validate_lock_text` in Python.
