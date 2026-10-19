// Reading decisions.lock from disk, with the same strict checks as the event log.
// Part of twosystems, created by Shashikant.
import { readFile } from "node:fs/promises";
import { MAX_LOCK_BYTES, validateLockText } from "./contracts.js";
import { type LoadedLock, lockHash } from "./lock.js";
import type { DecisionsLock } from "./model.js";

/**
 * Read and validate a decisions.lock file. Returns null when the file does not
 * exist; throws an Error listing the problems when it is invalid.
 */
export async function readLock(path: string): Promise<LoadedLock | null> {
  let text: string;
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_LOCK_BYTES + 3) throw new Error(`${path} is longer than ${MAX_LOCK_BYTES} bytes`);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const result = validateLockText(text);
  if (!result.ok) throw new Error(`${path} is not a valid decisions.lock: ${result.errors.slice(0, 5).join("; ")}`);
  const lock = JSON.parse(text.replace(/^﻿/, "")) as DecisionsLock;
  return { lock, hash: lockHash(lock), source: path };
}
