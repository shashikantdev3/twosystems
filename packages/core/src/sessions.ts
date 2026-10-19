// Session notes: what a hook command remembers between calls. Every hook call is
// a new process, so recent observations are kept in a small file per session
// under ~/.twosystems/sessions. Text is redacted and shortened before it is
// stored, and notes not used for a week are removed (checked once a day).
// Agents may run several hooks at once, so every change to a notes file
// happens under a short lock.
// Part of twosystems, created by Shashikant.
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./questions.js";
import { redact } from "./redact.js";
import type { Observation } from "./signals.js";

export const SESSION_LIMITS = {
  observations: 80,
  textChars: 400,
  keepDays: 7,
  /** Longest wait for another hook to finish with the same notes. Holding the lock takes milliseconds. */
  lockWaitMs: 1000,
  /** A lock older than this was left by a hook that died, and is taken over. */
  staleLockMs: 3000,
} as const;

export interface PendingAsk {
  decisionId: string;
  toolUseId?: string;
  at: number;
}

export interface PendingFreshStart {
  decisionId: string;
  agent: string;
  session: string;
  suggestion: "clear" | "compact";
  at: number;
}

export interface SessionNotes {
  v: 1;
  agent: string;
  session: string;
  observations: Observation[];
  /** Tool calls seen since the notes began. */
  toolCalls: number;
  /** Tool call count at the last stuck check, so the check is not repeated on every call. */
  lastStuckCheck?: number;
  /** Time of the last stuck check: only tool calls after it count as new evidence. */
  lastStuckCheckAt?: number;
  /** Set while one hook runs the stuck check, so a parallel hook does not run it too. */
  stuckCheckClaimedAt?: number;
  /** A stuck question the user has been asked and not yet answered. */
  pendingAsk?: PendingAsk;
  /** A fresh-start suggestion shown in this session, waiting for the user to compact. */
  pendingFreshStart?: PendingFreshStart;
  /** What the agent said about the prompt cache when the session resumed. */
  cacheHint?: { expired: boolean; at: number };
  /**
   * Rough size of the conversation: the last size the agent reported, plus about
   * a quarter of a token per character seen since.
   */
  estimatedTokens: number;
  /** True once the agent has reported a real size, so estimates are not logged as usage. */
  sizeReported?: boolean;
  /** The last usage record written, so the same request is not logged twice. */
  lastUsageKey?: string;
}

/** Redact and shorten text for storage. Line breaks are kept, so error lines stay apart. */
export function shorten(text: string): string {
  const clean = redact(text.slice(0, SESSION_LIMITS.textChars * 4));
  return clean.length <= SESSION_LIMITS.textChars ? clean : `${clean.slice(0, SESSION_LIMITS.textChars - 3)}...`;
}

/** Copy an observation with its text redacted and shortened, ready to be stored. */
export function storable(observation: Observation): Observation {
  if (observation.kind === "prompt") return { ...observation, text: shorten(observation.text) };
  if (observation.kind === "tool") {
    const copy = { ...observation };
    copy.tool = shorten(observation.tool).slice(0, 80);
    if (observation.command !== undefined) copy.command = shorten(observation.command);
    if (observation.error !== undefined) copy.error = shorten(observation.error);
    if (observation.files !== undefined) copy.files = observation.files.slice(0, 20).map(shorten);
    return copy;
  }
  return { ...observation };
}

function key(...parts: string[]): string {
  return sha256(parts.join("\n")).slice(7, 31);
}

function notesFile(dir: string, agent: string, session: string): string {
  return join(dir, `${key(agent, session)}.json`);
}

function freshNotes(agent: string, session: string): SessionNotes {
  return { v: 1, agent, session, observations: [], toolCalls: 0, estimatedTokens: 0 };
}

async function readNotes(path: string, agent: string, session: string): Promise<SessionNotes> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SessionNotes>;
    if (parsed.v !== 1 || parsed.session !== session || !Array.isArray(parsed.observations)) return freshNotes(agent, session);
    return { ...freshNotes(agent, session), ...parsed } as SessionNotes;
  } catch {
    return freshNotes(agent, session);
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold a lock while fn runs. The lock is a folder, which the file system
 * creates atomically. If another hook holds it for too long, carry on without
 * it: losing one observation is better than stalling the agent.
 */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + SESSION_LIMITS.lockWaitMs;
  let held = false;
  while (!held) {
    try {
      await mkdir(lock);
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > SESSION_LIMITS.staleLockMs) await rm(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) break;
      else await sleep(5 + Math.random() * 10);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Read the notes for a session without changing them. */
export async function loadNotes(dir: string, agent: string, session: string): Promise<SessionNotes> {
  return readNotes(notesFile(dir, agent, session), agent, session);
}

/**
 * Change the notes for a session under the lock: read the latest version, let
 * change() update it, and save it, keeping only the most recent observations.
 */
export async function updateNotes<T>(
  dir: string,
  agent: string,
  session: string,
  change: (notes: SessionNotes) => T,
): Promise<{ notes: SessionNotes; result: T }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = notesFile(dir, agent, session);
  return withLock(path, async () => {
    const notes = await readNotes(path, agent, session);
    const result = change(notes);
    notes.observations = notes.observations.slice(-SESSION_LIMITS.observations);
    await writeAtomic(path, JSON.stringify(notes));
    return { notes, result };
  });
}

/** Add an observation to the notes, redacted and in time order. */
export function remember(notes: SessionNotes, observation: Observation): void {
  notes.observations.push(storable(observation));
  notes.observations.sort((a, b) => a.at - b.at);
}

// A /clear starts a new session, so a clear suggestion is linked by agent and
// project folder rather than by session.
function pendingFile(dir: string, agent: string, cwd: string): string {
  return join(dir, `pending-${key(agent, cwd)}.json`);
}

export async function savePendingClear(dir: string, cwd: string, pending: PendingFreshStart): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(pendingFile(dir, pending.agent, cwd), JSON.stringify(pending));
}

/** Take the pending clear suggestion for this agent and folder if it is recent enough, and forget it. */
export async function takePendingClear(
  dir: string,
  agent: string,
  cwd: string,
  now: number,
  maxAgeMs: number,
): Promise<PendingFreshStart | null> {
  const path = pendingFile(dir, agent, cwd);
  try {
    const pending = JSON.parse(await readFile(path, "utf8")) as PendingFreshStart;
    await rm(path, { force: true });
    return now - pending.at <= maxAgeMs ? pending : null;
  } catch {
    return null;
  }
}

/**
 * Remove notes and leftovers not touched for a week. Runs at most once a day,
 * using a marker file's time. Errors are ignored: this is housekeeping.
 */
export async function pruneNotes(dir: string, now: number): Promise<void> {
  const marker = join(dir, ".last-prune");
  try {
    const last = await stat(marker).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (now - last < 86_400_000) return;
    await writeFile(marker, "");
    await utimes(marker, now / 1000, now / 1000);
    for (const name of await readdir(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      const info = await stat(path);
      if (now - info.mtimeMs > SESSION_LIMITS.keepDays * 86_400_000) await rm(path, { recursive: true, force: true });
    }
  } catch {
    // Nothing to prune.
  }
}
