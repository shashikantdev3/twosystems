// The local event log: one JSON record per line in ~/.twosystems/events.jsonl,
// plus one file per session in ~/.twosystems/events.d/ from adapters that
// cannot append to a shared file (the Claude Code plugin). See decision 0006.
// Every record is checked against events.schema.json before it is written.
// Part of twosystems, created by Shashikant.
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TwoSystemsEvent } from "./contracts.js";
import { MAX_EVENT_BYTES, validateEvent, validateEventText } from "./contracts.js";

export { isToken, newId, timestamp } from "./ids.js";

/** Append one event. Throws if the event does not match the schema, so a bad adapter fails loudly in tests. */
export async function appendEvent(path: string, event: TwoSystemsEvent): Promise<void> {
  const result = validateEvent(event);
  if (!result.ok) throw new Error(`Refusing to write an invalid event: ${result.errors.slice(0, 5).join("; ")}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // One write per record, opened in append mode, so lines from parallel hooks do not mix.
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
}

export interface ReadResult {
  events: TwoSystemsEvent[];
  /** Lines that were not valid events, with their line numbers. They are skipped, not fatal. */
  problems: string[];
}

/**
 * Read every valid event from a log. Lines are split on "\n" with one trailing
 * "\r" removed, the same rule as validateEventsJsonl. A missing file reads as empty.
 */
export async function readEvents(path: string): Promise<ReadResult> {
  const events: TwoSystemsEvent[] = [];
  const problems: string[] = [];
  let number = 0;
  const take = (raw: string): void => {
    number += 1;
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (number === 1) line = line.replace(/^\uFEFF/, "");
    if (/^[ \t]*$/.test(line)) return;
    const result = validateEventText(line);
    if (result.ok) events.push(JSON.parse(line) as TwoSystemsEvent);
    else problems.push(`line ${number}: ${result.errors[0] ?? "invalid"}`);
  };
  // A line far longer than any valid event is reported and skipped without being held in memory.
  const tooLong = MAX_EVENT_BYTES * 4;
  let rest = "";
  let skipping = false;
  try {
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
      const parts = (rest + (chunk as string)).split("\n");
      rest = parts.pop() ?? "";
      for (const part of parts) {
        if (skipping) {
          number += 1;
          problems.push(`line ${number}: longer than ${MAX_EVENT_BYTES} bytes`);
          skipping = false;
        } else {
          take(part);
        }
      }
      if (rest.length > tooLong) {
        rest = "";
        skipping = true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events, problems };
    throw error;
  }
  if (skipping) {
    number += 1;
    problems.push(`line ${number}: longer than ${MAX_EVENT_BYTES} bytes`);
  } else {
    take(rest);
  }
  return { events, problems };
}

/**
 * Read the whole event log: events.jsonl, then every .jsonl file in the
 * events.d folder in name order. Each problem names its file. An event that
 * appears twice (same id) is kept once.
 */
export async function readEventLog(paths: { eventsPath: string; eventsDir: string }): Promise<ReadResult> {
  const files = [paths.eventsPath];
  try {
    const names = (await readdir(paths.eventsDir)).filter((name) => name.endsWith(".jsonl")).sort();
    files.push(...names.map((name) => join(paths.eventsDir, name)));
  } catch (error) {
    // No folder, or something that is not a folder: there are no per-session files to read.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const events: TwoSystemsEvent[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const result = await readEvents(file);
    for (const event of result.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
    problems.push(...result.problems.map((problem) => `${basename(file)} ${problem}`));
  }
  return { events, problems };
}
