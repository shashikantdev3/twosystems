// The twosystems command: hook, receipt, doctor.
// Part of twosystems, created by Shashikant. https://github.com/shashikantdev3/twosystems
import { access, appendFile, constants, mkdir, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Agent, DecisionName, Engine as EngineInfo } from "./contracts.js";
import { type Config, cacheTtlFor, readConfig } from "./config.js";
import { createEngine } from "./engines/index.js";
import { EngineError } from "./engines/types.js";
import { readEvents } from "./eventlog.js";
import { handleHook, recordEvents } from "./hookrunner.js";
import { type LoadedLock, builtInLock, readLock } from "./lock.js";
import { QUESTIONS } from "./questions.js";
import { type Receipt, buildReceipt } from "./receipt.js";
import type { SignalName } from "./signals.js";
import { VERSION } from "./version.js";

const AGENTS: readonly Agent[] = ["claude-code", "copilot", "codex", "cursor", "windsurf", "other"];
const MAX_STDIN = 1_048_576;

const HELP = `twosystems ${VERSION}: a cheap, honest watchman for AI coding agents. Created by Shashikant.

Usage:
  twosystems hook --agent <name> [--event <name>]   Run as an agent hook: JSON in on stdin, JSON out on stdout.
  twosystems receipt [--days <n>] [--json]          What twosystems did, cost and saved.
  twosystems doctor [--live]                        Check the setup; --live asks the decision model once.
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

function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(2)}`;
}

/** The receipt as plain text. */
export function formatReceipt(r: Receipt, days: number | undefined): string {
  const lines: string[] = [];
  lines.push(`twosystems receipt${days === undefined ? "" : ` (last ${days} days)`}`);
  lines.push(`Sessions watched:        ${r.sessions}`);
  lines.push(
    `Checks run:              ${r.decisions.total} (act ${r.decisions.byBand.act}, unsure ${r.decisions.byBand.unsure}, silent ${r.decisions.byBand.silent}, not evaluated ${r.decisions.byBand.not_evaluated})`,
  );
  lines.push(`Suggestions shown:       ${r.decisions.shown} (held back on purpose: ${r.decisions.heldOut})`);
  lines.push(`Taken / declined:        ${r.actions.accepted} / ${r.actions.declined}`);
  lines.push(`Our own cost:            ${money(r.ownCostUsd)}`);
  lines.push(`Estimated tokens saved:  ${r.estimatedTokensSaved.toLocaleString("en-US")} (an estimate, not a measurement)`);
  const v = r.verified;
  if (v.status === "not_enough_data") {
    lines.push(`Verified saving:         not enough data yet (${v.shown} shown and ${v.heldOut} held back; ${v.needed} of each needed)`);
  } else {
    const fmt = (x: number) => (v.unit === "usd" ? money(x) : `${Math.round(x).toLocaleString("en-US")} tokens`);
    const range = `${fmt(v.perMoment.low)} to ${fmt(v.perMoment.high)}`;
    lines.push(
      v.status === "verified"
        ? `Verified saving:         ${fmt(v.perMoment.mean)} per suggestion (95% interval ${range})`
        : `Verified saving:         no clear effect yet (95% interval ${range} per suggestion)`,
    );
  }
  return lines.join("\n");
}

async function runReceipt(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { days: { type: "string" }, json: { type: "boolean" } } });
  const config = readConfig();
  const days = values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    process.stderr.write("--days must be a positive number\n");
    return 2;
  }
  const { events, problems } = await readEvents(config.eventsPath);
  const since = days === undefined ? -Infinity : Date.now() - days * 86_400_000;
  const receipt = buildReceipt(events.filter((e) => Date.parse(e.ts) >= since));
  if (values.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else process.stdout.write(`${formatReceipt(receipt, days)}\n`);
  if (problems.length > 0) process.stderr.write(`Skipped ${problems.length} unreadable line(s) in ${config.eventsPath}.\n`);
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

  const { events, problems } = await readEvents(config.eventsPath);
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

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "hook":
      return runHook(rest);
    case "receipt":
      return runReceipt(rest);
    case "doctor":
      return runDoctor(rest);
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
