// Writing and reading the event log from inside Claude Code. A plugin cannot
// append to a file, so each session gets its own small files in
// ~/.twosystems/events.d/, each rewritten whole on each change (decision 0006).
// Parts are kept small (256 KB), so a write cut short by a crash loses little.
// Writes are queued one after another, so parallel hooks never lose a line.
// Part of twosystems, created by Shashikant.
import { type TwoSystemsEvent, isToken } from "../core/portable.js";

/** The file operations the log needs; the plugin passes Claude Code's own. */
export interface LogFiles {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<readonly { name: string; kind: string; size: number }[]>;
}

/** A session file this large starts a new part. */
const PART_BYTES = 256_000;
/** The shared log is read only up to this size here; `twosystems receipt` reads any size. */
const READ_LIMIT = 4_000_000;

/** A Windows path: a drive letter (C:\) or a network share (\\server). */
const WINDOWS_PATH = /^([A-Za-z]:[\\/]|\\\\)/;
/** A drive as Git Bash writes it (/c/Users/...). */
const MSYS_DRIVE = /^\/[A-Za-z]\//;

/**
 * The twosystems folder: TWOSYSTEMS_HOME, else .twosystems in the home folder.
 * On Windows the home folder is USERPROFILE, elsewhere HOME, as Node's
 * os.homedir() and so the twosystems command use, so both read and write the
 * same folder. A mod cannot ask which system it runs on, so this is Windows
 * when USERPROFILE is a Windows path and HOME is unset or a Windows path too:
 * WSL and some shells forward USERPROFILE to Linux, where HOME is /home/...
 */
export function homeFolder(env: { twosystemsHome?: string; home?: string; userProfile?: string }): string | null {
  const own = env.twosystemsHome?.trim();
  if (own) return own.replace(/[\\/]+$/, "");
  const profile = env.userProfile?.trim();
  const posixHome = env.home?.trim();
  const windows =
    profile !== undefined && WINDOWS_PATH.test(profile) && (!posixHome || WINDOWS_PATH.test(posixHome) || MSYS_DRIVE.test(posixHome));
  const home = windows ? profile : posixHome || undefined;
  return home ? `${home.replace(/[\\/]+$/, "")}/.twosystems` : null;
}

function baseName(session: string): string {
  const safe = isToken(session) && !session.includes("/") ? session : "session";
  return `claude-code-${safe.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

function fileName(session: string, part: number): string {
  return `${baseName(session)}${part > 1 ? `-${part}` : ""}.jsonl`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export class EventLog {
  private readonly dir: string | null;
  private queue: Promise<void> = Promise.resolve();
  /** What each session's current part holds, so a write never needs a read first. */
  private readonly text = new Map<string, string>();
  /** Each session's current part number, found on the first write after a load. */
  private readonly part = new Map<string, number>();
  /** Problems while writing, kept for /twosystems; never thrown at the session. */
  readonly problems: string[] = [];

  constructor(home: string | null) {
    this.dir = home === null ? null : `${home}/events.d`;
  }

  get folder(): string | null {
    return this.dir;
  }

  /** Resolves once every write queued so far has finished. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** The highest part a session already has on disk, so a reload carries on where it left off. */
  private async currentPart(files: LogFiles, dir: string, session: string): Promise<number> {
    const known = this.part.get(session);
    if (known !== undefined) return known;
    const base = baseName(session);
    let part = 1;
    for (const entry of await files.list(dir).catch(() => [])) {
      if (entry.name === `${base}.jsonl`) continue;
      const match = new RegExp(`^${base.replace(/[.]/g, "\\.")}-(\\d+)\\.jsonl$`).exec(entry.name);
      if (match) part = Math.max(part, Number(match[1]));
    }
    this.part.set(session, part);
    return part;
  }

  private async load(files: LogFiles, path: string): Promise<string> {
    const cached = this.text.get(path);
    if (cached !== undefined) return cached;
    let current = (await files.exists(path)) ? stripBom(await files.read(path)) : "";
    if (current !== "" && !current.endsWith("\n")) current += "\n";
    return current;
  }

  /** Add events to their sessions' files. Resolves once written; never rejects. */
  append(files: LogFiles, events: readonly TwoSystemsEvent[]): Promise<void> {
    if (this.dir === null || events.length === 0) return this.queue;
    const dir = this.dir;
    this.queue = this.queue.then(async () => {
      try {
        for (const [session, group] of groupBySession(events)) {
          let part = await this.currentPart(files, dir, session);
          let path = `${dir}/${fileName(session, part)}`;
          let current = await this.load(files, path);
          const lines = group.map((event) => `${JSON.stringify(event)}\n`).join("");
          if (current !== "" && current.length + lines.length > PART_BYTES) {
            part += 1;
            this.part.set(session, part);
            path = `${dir}/${fileName(session, part)}`;
            current = await this.load(files, path);
          }
          const next = current + lines;
          await files.write(path, next);
          this.text.set(path, next);
        }
      } catch (error) {
        this.problems.push(`could not write the event log: ${(error as Error).message}`.slice(0, 200));
        if (this.problems.length > 20) this.problems.shift();
      }
    });
    return this.queue;
  }

  /**
   * Read every event this machine has: the shared events.jsonl (when it is
   * small enough to read here) and every session file. Lines that are not
   * event records are skipped and counted.
   */
  async readAll(files: LogFiles, home: string | null): Promise<{ events: TwoSystemsEvent[]; skipped: number; notes: string[] }> {
    const events: TwoSystemsEvent[] = [];
    const notes: string[] = [];
    let skipped = 0;
    if (home === null) return { events, skipped, notes: ["No home folder is known, so there is no event log."] };
    await this.queue;
    const seen = new Set<string>();
    const take = (text: string) => {
      for (const raw of stripBom(text).split("\n")) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim() === "") continue;
        const event = asEvent(line);
        if (event === null) skipped += 1;
        else if (!seen.has(event.id)) {
          seen.add(event.id);
          events.push(event);
        }
      }
    };
    const shared = (await files.list(home).catch(() => [])).find((entry) => entry.name === "events.jsonl");
    if (shared !== undefined) {
      if (shared.kind === "file" && shared.size > READ_LIMIT) {
        notes.push("events.jsonl is too large to read here; run `twosystems receipt` in a terminal for the full receipt.");
      } else {
        // A link reads through; a file too large to read is noted rather than thrown.
        const text = await files.read(`${home}/events.jsonl`).catch(() => null);
        if (text === null) notes.push("events.jsonl could not be read here; run `twosystems receipt` in a terminal for the full receipt.");
        else take(text);
      }
    }
    if (this.dir !== null) {
      const entries = await files.list(this.dir).catch(() => []);
      for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!entry.name.endsWith(".jsonl") || (entry.kind === "file" && entry.size > READ_LIMIT)) continue;
        take(await files.read(`${this.dir}/${entry.name}`).catch(() => ""));
      }
    }
    return { events, skipped, notes };
  }
}

function groupBySession(events: readonly TwoSystemsEvent[]): Map<string, TwoSystemsEvent[]> {
  const groups = new Map<string, TwoSystemsEvent[]>();
  for (const event of events) {
    const group = groups.get(event.session) ?? [];
    group.push(event);
    groups.set(event.session, group);
  }
  return groups;
}

const TYPES = new Set(["usage", "decision", "user_action"]);

/**
 * A line read back as an event record, or null. This is a light check of the
 * fields the receipt uses; the twosystems command validates every field.
 */
function asEvent(line: string): TwoSystemsEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = record["type"];
  const ok =
    record["v"] === 1 &&
    typeof record["id"] === "string" &&
    typeof record["ts"] === "string" &&
    Number.isFinite(Date.parse(record["ts"] as string)) &&
    typeof record["agent"] === "string" &&
    typeof record["session"] === "string" &&
    typeof type === "string" &&
    TYPES.has(type) &&
    record[type] !== null &&
    typeof record[type] === "object";
  return ok ? (record as unknown as TwoSystemsEvent) : null;
}
