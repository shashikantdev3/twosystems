// The twosystems command: hook, receipt, doctor, moments.
// Part of twosystems, created by Shashikant. https://github.com/shashikantdev3/twosystems
import { access, appendFile, constants, mkdir, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Agent, type DecisionName, type Engine as EngineInfo } from "./contracts.js";
import { type Config, cacheTtlFor, readConfig } from "./config.js";
import { createEngine } from "./engines/index.js";
import { EngineError } from "./engines/types.js";
import { readEventLog } from "./eventlog.js";
import { handleHook, recordEvents } from "./hookrunner.js";
import { type LoadedLock, builtInLock } from "./lock.js";
import { readLock } from "./lockfile.js";
import { mergeMoments } from "./moments.js";
import {
  MomentsFileError,
  defaultProjectsDir,
  findSessionFiles,
  hasScoreFrom,
  isCurrent,
  momentsFromSession,
  readMomentsFile,
  scoreMoments,
  updateMomentsFile,
} from "./momentsio.js";
import { RulesEngine } from "./engines/rules.js";
import { QUESTIONS } from "./questions.js";
import { buildReceipt } from "./receipt.js";
import { formatReceipt, money } from "./receipttext.js";

export { formatReceipt };
import type { SignalName } from "./signals.js";
import { VERSION } from "./version.js";

const AGENTS: readonly Agent[] = ["claude-code", "copilot", "codex", "cursor", "windsurf", "other"];
const MAX_STDIN = 1_048_576;

const HELP = `twosystems ${VERSION}: a cheap, honest watchman for AI coding agents. Created by Shashikant.

Usage:
  twosystems hook --agent <name> [--event <name>]   Run as an agent hook: JSON in on stdin, JSON out on stdout.
  twosystems receipt [--days <n>] [--json]          What twosystems did, cost and saved.
  twosystems doctor [--live]                        Check the setup; --live asks the decision model once.
  twosystems moments [options]                      Find moments in saved Claude Code sessions for calibration.
  twosystems version

Agents: ${AGENTS.join(", ")}.

Settings (environment variables):
  OPENROUTER_API_KEY       Key for the OpenRouter decisions API. Never printed.
  TWOSYSTEMS_ENGINE        rules, openrouter or ollama (default: openrouter with a key, else rules)
  TWOSYSTEMS_MODEL         Model id, for example microsoft/microsoft-decision-1-20261009 or nimble
  TWOSYSTEMS_HOLDOUT       Share of moments kept silent to measure real savings (default 0.1)
  TWOSYSTEMS_TIMEOUT_MS    Longest wait for the decision model, in ms (default 5000, at most 10000)
  TWOSYSTEMS_CACHE_TTL_S   Prompt cache lifetime in seconds (default 3600 for Claude Code, else 300)
  TWOSYSTEMS_HOME          Data folder (default ~/.twosystems)
  TWOSYSTEMS_LOCK          decisions.lock to use (default ~/.twosystems/decisions.lock)
  OLLAMA_HOST              Ollama address (default http://127.0.0.1:11434)

Docs: https://github.com/shashikantdev3/twosystems`;

const MOMENTS_HELP = `twosystems moments: find the moments in your saved Claude Code sessions where
twosystems would have asked its decision model, for labelling with
twosystems-calibrate. Everything stays on this machine unless you score with a
remote engine, which sends each moment's short redacted summary, as a live check would.

Usage:
  twosystems moments [--from <folder or file>]... [--days <n>] [--out <file>]
                     [--score | --rescore] [--labelled-only] [--window <tokens>]

  --from <path>     Saved sessions to read (default: ~/.claude/projects, or CLAUDE_CONFIG_DIR/projects).
  --days <n>        Only sessions changed in the last n days.
  --out <file>      Moments file to add to (default: ~/.twosystems/moments.jsonl). Labels and
                    scores already in it are kept.
  --score           Also ask the configured decision engine about moments it has not scored yet.
                    A remote engine receives each moment's short redacted summary.
  --rescore         Ask it again about every moment, to check for drift with twosystems-calibrate check.
  --labelled-only   With --score or --rescore: only moments that have a label.
  --cache-ttl <s>   Prompt cache lifetime for the cache-expired signal and the idle check
                    (default: as for the hook command).
  --window <tokens> Context window to assume (default: 1000000 for a session with a request over
                    200000 tokens, else 200000).

Every moment also gets a free score from the rules engine.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_STDIN) throw new Error("hook input is larger than 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Problems inside a hook go to a small local log, never to the agent. */
async function logProblem(config: Config, message: string): Promise<void> {
  try {
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    const path = join(config.home, "twosystems.log");
    const info = await stat(path).catch(() => null);
    if (info !== null && info.size > 1_048_576) await truncate(path, 0);
    await appendFile(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Nowhere left to report; stay quiet so the agent is never disturbed.
  }
}

async function loadLock(config: Config, engineInfo: EngineInfo): Promise<LoadedLock> {
  return (await readLock(config.lockPath)) ?? builtInLock(engineInfo);
}

async function runHook(args: string[]): Promise<number> {
  const config = readConfig();
  let output: Record<string, unknown> = {};
  try {
    const { values } = parseArgs({ args, options: { agent: { type: "string" }, event: { type: "string" } }, strict: false });
    const agentName = typeof values.agent === "string" ? values.agent : "other";
    const agent: Agent = AGENTS.includes(agentName as Agent) ? (agentName as Agent) : "other";
    const event = typeof values.event === "string" ? values.event : undefined;
    const text = await readStdin();
    let payload: unknown = null;
    try {
      payload = text.trim() === "" ? null : JSON.parse(text);
    } catch {
      // Say what went wrong without copying any of the input into the log.
      throw new Error("hook input is not valid JSON");
    }
    const engine = createEngine(config);
    let lock: LoadedLock;
    try {
      lock = await loadLock(config, engine.info);
    } catch (error) {
      await logProblem(config, `decisions.lock ignored: ${(error as Error).message}`);
      lock = builtInLock(engine.info);
    }
    const result = await handleHook(payload, event, { config, engine, lock, agent, adapterVersion: VERSION, now: Date.now() });
    await recordEvents(config.eventsPath, result.events);
    output = result.output;
  } catch (error) {
    await logProblem(config, `hook: ${(error as Error).message}`);
  }
  // Always answer with valid JSON and exit 0: a watchman must never break the agent it watches.
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

async function runReceipt(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { days: { type: "string" }, json: { type: "boolean" } } });
  const config = readConfig();
  const days = values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    process.stderr.write("--days must be a positive number\n");
    return 2;
  }
  const { events, problems } = await readEventLog(config);
  const since = days === undefined ? -Infinity : Date.now() - days * 86_400_000;
  const receipt = buildReceipt(events.filter((e) => Date.parse(e.ts) >= since));
  if (values.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else process.stdout.write(`${formatReceipt(receipt, days)}\n`);
  if (problems.length > 0) process.stderr.write(`Skipped ${problems.length} unreadable line(s) in the event log under ${config.home}.\n`);
  return 0;
}

async function runDoctor(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { live: { type: "boolean" } } });
  const config = readConfig();
  let ok = true;
  const say = (good: boolean, text: string) => {
    if (!good) ok = false;
    process.stdout.write(`${good ? "ok  " : "FIX "} ${text}\n`);
  };
  process.stdout.write(`twosystems ${VERSION} doctor\n`);
  const major = Number(process.versions.node.split(".")[0]);
  say(major >= 22, `Node.js ${process.versions.node} (22 or newer needed)`);

  try {
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    await access(config.home, constants.W_OK);
    say(true, `data folder ${config.home} is writable`);
  } catch {
    say(false, `data folder ${config.home} is not writable`);
  }

  const { events, problems } = await readEventLog(config);
  say(problems.length === 0, `event log: ${events.length} events${problems.length > 0 ? `, ${problems.length} unreadable lines` : ""}`);

  const engine = createEngine(config);
  let lock: LoadedLock | null = null;
  try {
    lock = await readLock(config.lockPath);
    say(true, lock === null ? "decisions.lock: none yet, using built-in thresholds (not fitted)" : `decisions.lock: ${lock.source}`);
  } catch (error) {
    say(false, (error as Error).message);
  }

  const model = engine.info.model ? ` (${engine.info.model})` : "";
  say(true, `engine: ${engine.info.kind}${model}${engine.remote ? ", sends a short redacted summary off this machine" : ", stays on this machine"}`);
  if (config.engine === "openrouter") say(config.openRouterKey !== undefined, `OpenRouter key: ${config.openRouterKey ? "set" : "missing (set OPENROUTER_API_KEY)"}`);
  if (config.engine === "ollama") say(config.model !== undefined, `Ollama model: ${config.model ?? "missing (set TWOSYSTEMS_MODEL, for example nimble)"}`);
  process.stdout.write(
    `     holdout ${config.holdoutRate}, timeout ${config.timeoutMs} ms, cache lifetime ${cacheTtlFor(config, "claude-code")} s for Claude Code and ${cacheTtlFor(config, "copilot")} s for others\n`,
  );
  for (const warning of config.warnings) say(false, warning);

  if (values.live) {
    // One real call per question, with fixed made-up moments, so the engine is
    // tried with exactly the questions twosystems asks.
    const samples: { name: DecisionName; state: string[]; signals: SignalName[] }[] = [
      {
        name: "stuck",
        state: [
          "Task at the start: make the login test pass",
          "Tool calls since the latest prompt: 6. The last 3, oldest first:",
          "- bash: npm test -> failed: AssertionError: expected 200, got 500",
          "- bash: npm test -> failed: AssertionError: expected 200, got 500",
          "- bash: npm test -> failed: AssertionError: expected 200, got 500",
          "Rule signals: repeated_command, repeated_error.",
        ],
        signals: ["repeated_command", "repeated_error"],
      },
      {
        name: "fresh_start",
        state: [
          "Task at the start: refactor the payment service to use the new billing client",
          "New prompt: write release notes for the Android app store listing",
          "Conversation size: 150000 tokens.",
          "Time since the last activity: 75 minutes.",
          "Rule signals: large_context, cache_expired, new_prompt_low_overlap.",
        ],
        signals: ["large_context", "cache_expired", "new_prompt_low_overlap"],
      },
    ];
    for (const sample of samples) {
      const started = performance.now();
      try {
        const answer = await engine.decide({
          question: QUESTIONS[sample.name],
          state: sample.state,
          signals: sample.signals,
          signal: AbortSignal.timeout(Math.max(config.timeoutMs, 10_000)),
        });
        const ms = Math.round(performance.now() - started);
        const probs = Object.entries(answer.probabilities)
          .map(([k, v]) => `${k} ${v.toFixed(2)}`)
          .join(", ");
        const cost = answer.costUsd === undefined ? "" : `, ${money(answer.costUsd)}`;
        say(true, `live ${sample.name} check: ${answer.modelVersion ?? engine.info.kind} answered in ${ms} ms${cost}: ${probs}`);
      } catch (error) {
        const reason = error instanceof EngineError ? `${error.reason}: ${error.message}` : (error as Error).message;
        say(false, `live ${sample.name} check failed (${reason})`);
      }
    }
  }
  if (!values.live) process.stdout.write("     Run `twosystems doctor --live` to try the decision model with one real call per question.\n");
  return ok ? 0 : 1;
}

async function runMoments(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        from: { type: "string", multiple: true },
        days: { type: "string" },
        out: { type: "string" },
        score: { type: "boolean" },
        rescore: { type: "boolean" },
        "labelled-only": { type: "boolean" },
        "cache-ttl": { type: "string" },
        window: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nRun twosystems moments --help.\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${MOMENTS_HELP}\n`);
    return 0;
  }
  const config = readConfig();
  const days = values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    process.stderr.write("--days must be a positive number\n");
    return 2;
  }
  const ttl = values["cache-ttl"] === undefined ? cacheTtlFor(config, "claude-code") : Number(values["cache-ttl"]);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    process.stderr.write("--cache-ttl must be a positive number of seconds\n");
    return 2;
  }
  const window = values.window === undefined ? undefined : Number(values.window);
  if (window !== undefined && (!Number.isInteger(window) || window < 1_000)) {
    process.stderr.write("--window must be a whole number of tokens, such as 200000 or 1000000\n");
    return 2;
  }
  const out = values.out ?? join(config.home, "moments.jsonl");

  let kept;
  try {
    kept = await readMomentsFile(out);
  } catch (error) {
    const reason = error instanceof MomentsFileError ? error.message : `${out} could not be read`;
    process.stderr.write(`${reason}\nNothing was changed. Fix or move that file, then run again.\n`);
    return 1;
  }

  const sources = values.from ?? [defaultProjectsDir()];
  const { files, missing } = await findSessionFiles(sources, days);
  for (const source of missing) process.stderr.write(`Not found, skipped: ${source}\n`);
  const fresh = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      fresh.push(...(await momentsFromSession(file, { cacheTtlSeconds: ttl, ...(window === undefined ? {} : { window }) })));
    } catch {
      unreadable += 1;
    }
  }
  const { moments, changed } = mergeMoments(kept, fresh);

  // The rules engine is free and local, so every current moment gets its score.
  const rules = new RulesEngine();
  const unscoredByRules = moments.filter((m) => isCurrent(m) && !hasScoreFrom(m, rules));
  await scoreMoments(rules, unscoredByRules, { timeoutMs: 1000, concurrency: 1 });

  let scoring = "";
  if (values.score || values.rescore) {
    const engine = createEngine(config);
    if (engine.info.kind === "rules") {
      scoring = "No decision model is set up (set OPENROUTER_API_KEY, or TWOSYSTEMS_ENGINE=ollama), so only rules scores were added.";
    } else {
      const outdated = moments.filter((m) => !isCurrent(m)).length;
      const due = moments.filter(
        (m) => isCurrent(m) && (!values["labelled-only"] || m.label !== undefined) && (values.rescore || !hasScoreFrom(m, engine)),
      );
      const model = engine.info.model ? ` (${engine.info.model})` : "";
      const where = engine.info.kind === "ollama" ? "your local Ollama" : `${engine.info.kind}, a remote service`;
      process.stderr.write(`Scoring ${due.length} moment(s) with ${engine.info.kind}${model}: each moment's short redacted summary goes to ${where}...\n`);
      const result = await scoreMoments(engine, due, { timeoutMs: Math.max(config.timeoutMs, 10_000) });
      scoring = `Scored ${result.scored} moment(s) with ${engine.info.kind}${model}, ${money(result.costUsd)}.`;
      if (result.failed > 0) scoring += ` ${result.failed} failed (first: ${result.firstError ?? "unknown"}); run again to retry them.`;
      if (outdated > 0) scoring += ` ${outdated} moment(s) were built for an older wording of their question and were not scored.`;
    }
  }

  // Labels given in the meantime (twosystems-calibrate label) are kept: the file is read again under a lock and merged.
  let written;
  try {
    written = await updateMomentsFile(out, moments);
  } catch (error) {
    const reason = error instanceof MomentsFileError ? error.message : `${out} could not be written (${(error as Error).message})`;
    process.stderr.write(`${reason}\nNothing was changed.\n`);
    return 1;
  }
  const saved = written.moments;
  const keptIds = new Set(kept.map((m) => m.id));
  const added = saved.filter((m) => !keptIds.has(m.id)).length;
  const count = (name: string) => saved.filter((m) => m.decision === name).length;
  const labelled = saved.filter((m) => m.label !== undefined).length;
  const lines = [
    `Read ${files.length} saved session(s)${unreadable > 0 ? `, ${unreadable} could not be read` : ""}.`,
    `${saved.length} moment(s) in ${out}: ${count("stuck")} stuck, ${count("fresh_start")} fresh start; ${added} new, ${labelled} labelled.`,
  ];
  if (written.copies > 0) lines.push(`${written.copies} unlabelled copy(ies) of moments from forked or resumed sessions were left out.`);
  if (written.refused > 0) lines.push(`${written.refused} moment(s) did not fit the moments format and kept their saved version or were left out; please report this.`);
  if (changed > 0) lines.push(`${changed} moment(s) changed their question or summary since last time: labels kept, old scores dropped.`);
  if (scoring !== "") lines.push(scoring);
  lines.push("Next: twosystems-calibrate label (pip install --pre twosystems).");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "hook":
      return runHook(rest);
    case "receipt":
      return runReceipt(rest);
    case "doctor":
      return runDoctor(rest);
    case "moments":
      return runMoments(rest);
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP}\n`);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`Unknown command "${command}". Run twosystems --help.\n`);
      return 2;
  }
}
