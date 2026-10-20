// Files for calibration: finding saved Claude Code sessions, reading them,
// keeping moments.jsonl, and scoring moments with a decision engine.
// Part of twosystems, created by Shashikant.
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { validateMoment, validateMomentText } from "./contracts.js";
import { EngineError, type DecisionEngine } from "./engines/types.js";
import { isToken, timestamp } from "./ids.js";
import type { Moment, MomentScore } from "./model.js";
import { MOMENT_RULES, dropCopies, engineKey, findMoments, mergeOntoDisk } from "./moments.js";
import { QUESTIONS, questionHash } from "./questions.js";
import type { SignalName } from "./signals.js";
import { TimelineBuilder, inferWindow } from "./transcript.js";

/** Where Claude Code keeps saved sessions: CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function defaultProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const config = env["CLAUDE_CONFIG_DIR"]?.trim();
  return join(config || join(homedir(), ".claude"), "projects");
}

/**
 * The main session files under the given folders or files: <project>/<session>.jsonl.
 * Subagent files in deeper folders are left out. With `days`, only files
 * changed in that many days. Sorted, so the same input gives the same output.
 * `missing` lists the sources that do not exist.
 */
export async function findSessionFiles(
  sources: readonly string[],
  days?: number,
  now = Date.now(),
): Promise<{ files: string[]; missing: string[] }> {
  const found = new Set<string>();
  const missing: string[] = [];
  const since = days === undefined ? -Infinity : now - days * 86_400_000;
  const consider = async (path: string) => {
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && path.endsWith(".jsonl") && info.mtimeMs >= since) found.add(path);
  };
  for (const source of sources) {
    const info = await stat(source).catch(() => null);
    if (info === null) {
      missing.push(source);
      continue;
    }
    if (info.isFile()) {
      await consider(source);
      continue;
    }
    // A projects folder holds one folder per project; a project folder holds the session files.
    for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
      const path = join(source, entry.name);
      if (entry.isFile()) await consider(path);
      else if (entry.isDirectory()) {
        for (const inner of await readdir(path, { withFileTypes: true }).catch(() => [])) {
          if (inner.isFile()) await consider(join(path, inner.name));
        }
      }
    }
  }
  return { files: [...found].sort(), missing };
}

/** Call `each` with every line of a JSON Lines file that parses, read as a stream so large files are fine. */
export async function eachJsonLine(path: string, each: (value: unknown) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A line cut short by a crash; the rest of the session is still useful.
      continue;
    }
    each(value);
  }
}

/** Every line of a JSON Lines file that parses. */
export async function readJsonLines(path: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  await eachJsonLine(path, (value) => entries.push(value));
  return entries;
}

export interface SessionReadOptions {
  cacheTtlSeconds: number;
  /** The context window to assume; by default it is inferred from the largest request in the session. */
  window?: number;
}

/**
 * The moments found in one saved Claude Code session file, read line by line.
 * The window is the one given, else 1M tokens when a request in the session
 * was larger than 200,000 tokens, else 200,000.
 */
export async function momentsFromSession(path: string, options: SessionReadOptions): Promise<Moment[]> {
  const builder = new TimelineBuilder();
  await eachJsonLine(path, (value) => builder.add(value));
  const events = builder.finish();
  const session = builder.session ?? basename(path).replace(/\.jsonl$/, "");
  const window = options.window ?? inferWindow(builder.largest);
  return findMoments(events, { agent: "claude-code", session, cacheTtlSeconds: options.cacheTtlSeconds, window });
}

export class MomentsFileError extends Error {}

/**
 * Read moments.jsonl. A missing file is an empty list. A line that is not a
 * valid moment, or that repeats an id, stops the read with its line number, so
 * a later write never drops labels it could not understand.
 */
export async function readMomentsFile(path: string): Promise<Moment[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new MomentsFileError(`${path} could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
  let text: string;
  try {
    // Refused rather than read with replacement characters, which a write would then make permanent.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MomentsFileError(`${path} is not UTF-8 text`);
  }
  const moments: Moment[] = [];
  const lineOf = new Map<string, number>();
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  body.split("\n").forEach((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (/^[ \t]*$/.test(line)) return;
    const result = validateMomentText(line);
    if (!result.ok) throw new MomentsFileError(`${path} line ${index + 1}: ${result.errors[0] ?? "not a valid moment"}`);
    const moment = JSON.parse(line) as Moment;
    const first = lineOf.get(moment.id);
    if (first !== undefined) throw new MomentsFileError(`${path} line ${index + 1}: the id ${moment.id} is already used on line ${first}`);
    lineOf.set(moment.id, index + 1);
    moments.push(moment);
  });
  return moments;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Windows refuses a rename while another program (a virus scanner, an editor) has the file open; it clears in a moment. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await sleep(50 * (attempt + 1));
    }
  }
}

/**
 * Write moments.jsonl whole, through a temporary file, so a crash never leaves
 * half a file. The file is readable by its owner only, like the sessions it
 * comes from. Use updateMomentsFile when another command may be writing too.
 */
export async function writeMomentsFile(path: string, moments: readonly Moment[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(temporary, moments.map((m) => `${JSON.stringify(m)}\n`).join(""), { mode: 0o600 });
    await renameRetrying(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** How the moments file is shared between commands: this module's and the Python package's. */
export const MOMENTS_LOCK = {
  /** Longest wait for another command to finish writing. */
  waitMs: 10_000,
  /** A lock this old was left by a command that crashed, and is taken over. */
  staleMs: 120_000,
} as const;

/** Failures that mean "someone else has the lock right now": on Windows a lock being deleted can refuse to open for a moment. */
const BUSY = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

async function readOrNull(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

/**
 * Run `work` while holding `<path>.lock`, a small file created exclusively, so
 * two commands never write moments.jsonl at once. The Python package uses the
 * same lock. A lock left by a crashed command is taken over after two minutes,
 * checking just before removing it that it is still the same stale file, so
 * two waiters do not both take it over (best effort: the check and the removal
 * are two steps). The lock is removed afterwards only if it is still this
 * command's.
 */
export async function withMomentsLock<T>(path: string, work: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mine = `${process.pid} ${new Date().toISOString()} ${Math.random().toString(36).slice(2)}\n`;
  const started = now();
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(mine).finally(() => handle.close());
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const info = await stat(lock).catch(() => null);
      if (!BUSY.has(code) || (info === null && code !== "EEXIST")) throw error;
      if (info !== null && now() - info.mtimeMs > MOMENTS_LOCK.staleMs) {
        // Removed only while it is still the same stale file, so a lock another waiter just took over is left alone.
        const recheck = await stat(lock).catch(() => null);
        const same = recheck !== null && recheck.mtimeMs === info.mtimeMs && recheck.ino === info.ino;
        if (same && (await rm(lock).then(() => true, () => false))) continue;
      }
      if (now() - started > MOMENTS_LOCK.waitMs) {
        throw new MomentsFileError(
          `${path} is being written by another twosystems command. If none is running, delete ${lock} and run again.`,
        );
      }
      await sleep(100);
    }
  }
  try {
    return await work();
  } finally {
    if ((await readOrNull(lock)) === mine) await rm(lock, { force: true }).catch(() => undefined);
  }
}

/**
 * Save this run's moments: under the lock, read the file again, put this run's
 * moments onto it (labels from the file, everything else from this run), drop
 * unlabelled copies of a moment from forked sessions, and write it. A moment
 * that would not validate keeps the file's copy, or is left out when the file
 * has none; `refused` counts both. Returns what was written.
 */
export async function updateMomentsFile(
  path: string,
  mine: readonly Moment[],
): Promise<{ moments: Moment[]; refused: number; copies: number }> {
  return withMomentsLock(path, async () => {
    const onDisk = await readMomentsFile(path);
    const diskById = new Map(onDisk.map((m) => [m.id, m]));
    const { moments: merged, dropped: copies } = dropCopies(mergeOntoDisk(onDisk, mine), new Set(diskById.keys()));
    let refused = 0;
    const moments: Moment[] = [];
    for (const m of merged) {
      if (validateMoment(m).ok) {
        moments.push(m);
        continue;
      }
      refused += 1;
      const disk = diskById.get(m.id);
      if (disk !== undefined) moments.push(disk);
    }
    await writeMomentsFile(path, moments);
    return { moments, refused, copies };
  });
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** True when the moment was built for today's wording of its question, so a score means something. */
export function isCurrent(moment: Moment): boolean {
  return moment.question_hash === questionHash(QUESTIONS[moment.decision]);
}

export function hasScoreFrom(moment: Moment, engine: DecisionEngine): boolean {
  const key = engineKey(engine.info);
  return moment.scores.some((s) => engineKey(s.engine) === key);
}

/** Ask one engine about one moment, with the same question and summary the live check would send. */
export async function scoreMoment(engine: DecisionEngine, moment: Moment, timeoutMs: number, now = Date.now()): Promise<MomentScore> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const answer = await engine.decide({
      question: QUESTIONS[moment.decision],
      state: moment.state.lines,
      signals: moment.signals as SignalName[],
      signal: controller.signal,
    });
    const engineInfo: MomentScore["engine"] = { ...engine.info };
    // A model version the provider reports with spaces or odd characters is left out, as the event log does.
    if (answer.modelVersion !== undefined && isToken(answer.modelVersion)) engineInfo.model_version = answer.modelVersion;
    const probabilities = Object.fromEntries(
      Object.entries(answer.probabilities)
        .filter(([label]) => moment.labels.includes(label))
        .map(([label, p]) => [label, round(Math.min(1, Math.max(0, p)))]),
    );
    if (Object.keys(probabilities).length === 0) throw new EngineError("bad_response", "the answer had no probability for any label");
    const score: MomentScore = { engine: engineInfo, probabilities, at: timestamp(now) };
    if (answer.costUsd !== undefined && Number.isFinite(answer.costUsd) && answer.costUsd >= 0) score.cost_usd = answer.costUsd;
    return score;
  } catch (error) {
    if (controller.signal.aborted) throw new EngineError("timeout", "the decision model did not answer in time");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface ScoreSummary {
  scored: number;
  failed: number;
  costUsd: number;
  firstError?: string;
}

/**
 * Score moments with an engine, a few at a time. Each score is added to its
 * moment in place, oldest scores dropping off past 32. A moment whose new
 * score fails, or would make it fail validation, keeps what it had.
 */
export async function scoreMoments(
  engine: DecisionEngine,
  moments: readonly Moment[],
  options: { timeoutMs: number; concurrency?: number },
): Promise<ScoreSummary> {
  const summary: ScoreSummary = { scored: 0, failed: 0, costUsd: 0 };
  const fail = (message: string) => {
    summary.failed += 1;
    summary.firstError ??= message;
  };
  let next = 0;
  const worker = async () => {
    while (next < moments.length) {
      const moment = moments[next];
      next += 1;
      if (moment === undefined) continue;
      try {
        const score = await scoreMoment(engine, moment, options.timeoutMs);
        const scores = [...moment.scores, score].slice(-MOMENT_RULES.scores);
        const check = validateMoment({ ...moment, scores });
        if (!check.ok) {
          fail(`the answer could not be stored (${check.errors[0] ?? "invalid"})`);
          continue;
        }
        moment.scores = scores;
        summary.scored += 1;
        summary.costUsd += score.cost_usd ?? 0;
      } catch (error) {
        fail(error instanceof EngineError ? `${error.reason}: ${error.message}` : (error as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  return summary;
}
