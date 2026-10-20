# twosystems (Python)

Calibration and checking tools for [twosystems](https://github.com/shashikantdev3/twosystems), a cheap, honest watchman for AI coding agents created by Shashikant. The watchman itself (the Claude Code plugin, and the `twosystems` command with its hooks for Claude Code, GitHub Copilot and Codex) is on npm and GitHub; this package works on the files it writes.

**Status: alpha (0.1.0a3).** Every command below works and is tested. The default thresholds twosystems ships are still cautious guesses until they are fitted on about 300 labelled moments. See the [roadmap](https://github.com/shashikantdev3/twosystems/blob/main/docs/roadmap.md).

## Fit thresholds on your own sessions

twosystems acts when its decision model is confident enough. Calibration makes "confident enough" mean something you can check: with 95% confidence, no more than 5% of its interruptions are wrong (both numbers are yours to set), measured on moments you labelled yourself. The guarantee assumes those moments are a fair sample of the ones to come; moments from one session are alike, so treat it as a little optimistic. You need Node.js 22 and Python 3.10 or newer on the machine where you use Claude Code.

```bash
npm install --global twosystems@alpha
pip install --pre twosystems

twosystems moments                     # 1. find the moments in your saved Claude Code sessions (free)
twosystems moments --score             #    optional: ask your decision model about each one
twosystems-calibrate label             # 2. label them, one key each
twosystems-calibrate fit               # 3. fit thresholds and write decisions.lock
twosystems-calibrate report            # 4. see what the thresholds do (twosystems-report.html)
```

1. `twosystems moments` reads your saved Claude Code sessions (`~/.claude/projects`; `--days 30` for recent ones only) and replays each one the way the Claude Code plugin watches a live session: before a tool call, after a turn, after an idle spell, and when it would hold a typed prompt. Wherever it would have asked its decision model, it keeps a *moment* in `~/.twosystems/moments.jsonl`: the redacted summary the model would have read, and a few redacted lines of what happened next. Every moment gets a free score from the rules engine. `--score` also asks your decision model, which sends each moment's short summary to it, as a live check would (with OpenRouter, about $0.00002 a moment); fit thresholds for the engine you will run. Running it again adds new moments and keeps your labels.
2. `twosystems-calibrate label` shows one moment at a time and asks one key: for a stuck moment `s` (stuck) or `p` (progressing); for a fresh-start moment `k` (continue), `m` (compact) or `c` (clear). `x` skips, `u` undoes, `q` saves and quits. Every answer is saved at once, so you can stop and come back, even while `twosystems moments` runs. Moments come one session at a time in turn, so stopping early still covers many sessions. The model's answer is hidden so it cannot sway you; `--show-model` shows it and lets Enter accept it, which is quicker but less independent.
3. `twosystems-calibrate fit` keeps a quarter of your sessions aside to test on. On the rest it tries act thresholds from 1.00 down and keeps going only while the upper bound on false alarms stays at the target, stopping at the first that fails; trying them in that fixed order is what keeps the 95% honest. It prints the bound on the fitting part and on the sessions kept aside (with a verdict only when they hold enough acts), then writes `~/.twosystems/decisions.lock`, which the Claude Code plugin uses from its next start, and so does the `twosystems` command unless `TWOSYSTEMS_LOCK` points it elsewhere. It fits on the answers of one model version, the newest; moments scored only by an older one are left out until you rescore them. A lock is used only with the engine and question wording it was fitted for, and not when the model reports a version other than the one it was fitted on (when either side gives no version, it is used). With too few labels it says how many acts it needs instead of writing a weak lock. The same labels always give the same file.
4. Later, after a model update, run `twosystems moments --rescore --labelled-only` once and then `twosystems-calibrate check`: it compares each moment's last two scorings, and fails if the question or the model version changed, if the answers drifted, or if false alarms went above the target.

## Commands

The command is `twosystems-calibrate`, so it does not clash with the `twosystems` command from npm. Exit codes: 0 valid or passed, 1 invalid or failed, 2 a usage or file problem.

- `validate events|lock|moments FILE`: check a file against the shared schemas. It prints at most 100 problems and reads at most 64 MiB of an events log.
- `label [--moments FILE] [--decision stuck|fresh_start] [--show-model]`
- `fit [--moments FILE] [--out FILE] [--force] [--target 0.05] [--confidence 0.95] [--test-share 0.25] [--holdout 0.1] [--engine KIND[:MODEL]]`. `--holdout` is written into the lock as a record; the share twosystems actually keeps silent at run time comes from `TWOSYSTEMS_HOLDOUT` or the plugin's holdout setting.
- `check [--moments FILE] [--lock FILE] [--max-drift 0.05] [--max-band-changes 0.10]`
- `report [--moments FILE] [--lock FILE] [--out twosystems-report.html]`: one self-contained page with the labels, what each act threshold would do, the fitted thresholds and what twosystems did. For the token savings, run `twosystems receipt`.

Files default to the twosystems folder: `TWOSYSTEMS_HOME`, else `.twosystems` in your home folder. `TWOSYSTEMS_LOCK` names another lock for the `twosystems` command; the Claude Code plugin reads only `decisions.lock` in the twosystems folder.

## Privacy

`moments.jsonl` holds redacted text from your sessions (secrets, keys and long random strings are removed, and each piece is cut short), because labelling needs to see what happened. It is built from the session files already on your machine, stays there, and is readable by you only. Nothing is sent anywhere unless you score with a remote decision model, which then receives each moment's short summary exactly as a live check would send it.

## Library

`twosystems.contracts` offers `validate_event`, `validate_event_text`, `validate_events_jsonl`, `validate_lock`, `validate_lock_text`, `validate_moment`, `validate_moment_text`, `iter_events_jsonl` (one line at a time, to stop early on a large log), `parse_json` and `is_well_formed`, plus the limits `MAX_DEPTH`, `MAX_EVENT_BYTES`, `MAX_LOCK_BYTES`, `MAX_MOMENT_BYTES`, `MAX_EVENT_VALUES`, `MAX_LOCK_VALUES` and `MAX_MOMENT_VALUES`. They apply the same rules as the TypeScript core and run the same shared cases, including the exact error messages; see [`schemas/README.md`](https://github.com/shashikantdev3/twosystems/blob/main/schemas/README.md). `twosystems.moments` reads and writes `moments.jsonl` under its lock file. `twosystems.fit`, `twosystems.check`, `twosystems.thresholds` and `twosystems.stats` hold the fitting, the checks, the threshold rule and the confidence bound.

Part of [twosystems](https://github.com/shashikantdev3/twosystems), created by Shashikant. Apache License 2.0.
