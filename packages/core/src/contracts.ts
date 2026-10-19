// Types and validators for the two shared files: the event log and decisions.lock.
// The JSON Schemas in /schemas are the source of truth; these types mirror them.
// The Python package implements the same rules, and both run the shared edge
// cases in /schemas/examples, so any difference between the two fails CI.
// Part of twosystems, created by Shashikant.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Ajv2020 as Ajv2020Type } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

export * from "./model.js";
import { MAX_EVENT_BYTES, MAX_LOCK_BYTES } from "./model.js";
import type { DecisionsLock, ValidationResult } from "./model.js";

// RFC 3339 date-time with a mandatory time zone. Checked by hand rather than
// with ajv-formats so that this file and the Python package apply exactly the
// same rule: no leap seconds, no space separator, offsets as +HH:MM only.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function isDateTime(value: string): boolean {
  const m = DATE_TIME.exec(value);
  if (m === null) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = m
    .slice(1)
    .map((part) => Number(part ?? "0")) as [number, number, number, number, number, number, number, number];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function loadSchema(file: string): object {
  const url = new URL(`../../schemas/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as object;
}

/**
 * A string that is equal for equal JSON values: 1 and 1.0 match, true and 1
 * do not, and objects ignore key order, as in JSON Schema. The Python package
 * builds the same kind of key. Nesting is already limited, so recursion is shallow.
 */
function canonical(value: unknown): string {
  if (value === null) return "z";
  if (typeof value === "number") return `n${String(value)}`;
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "t" : "f";
  if (Array.isArray(value)) return `a[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `o{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return `x${String(value)}`;
}

/** uniqueItems in linear time, with one rule for every item type. */
function allUnique(unique: boolean, items: unknown[]): boolean {
  if (!unique) return true;
  const seen = new Set<string>();
  for (const item of items) {
    const key = canonical(item);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

// ajv is loaded and the schemas compiled on first use, so a hook call that
// writes nothing does not pay for them. ajv is CommonJS, so require keeps this synchronous.
let ajvInstance: Ajv2020Type | undefined;
function ajv(): Ajv2020Type {
  if (ajvInstance === undefined) {
    const { Ajv2020 } = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js");
    const instance = new Ajv2020({ allErrors: true, strict: true });
    instance.addFormat("date-time", { type: "string", validate: isDateTime });
    instance.addFormat("uuid", { type: "string", validate: isUuid });
    // ajv's own uniqueItems compares every pair of items, and takes a shortcut
    // that skips some duplicates when the item schema declares a type inline.
    instance.removeKeyword("uniqueItems");
    instance.addKeyword({ keyword: "uniqueItems", type: "array", schemaType: "boolean", errors: false, validate: allUnique });
    ajvInstance = instance;
  }
  return ajvInstance;
}

let compiledEvent: ValidateFunction | undefined;
let compiledLock: ValidateFunction | undefined;
function eventValidator(): ValidateFunction {
  compiledEvent ??= ajv().compile(loadSchema("events.schema.json"));
  return compiledEvent;
}
function lockValidator(): ValidateFunction {
  compiledLock ??= ajv().compile(loadSchema("decisions-lock.schema.json"));
  return compiledLock;
}

const SAFE_FIELD = /^[A-Za-z0-9_.-]{1,32}$/;

function fieldName(name: unknown): string {
  const text = String(name);
  return SAFE_FIELD.test(text) ? `'${text}'` : "(name not shown)";
}

/** JSON pointer to the bad value. Field names that are not plain short names show as *. */
function pointer(instancePath: string): string {
  if (instancePath === "") return "<root>";
  return instancePath
    .split("/")
    .slice(1)
    .map((part) => {
      const name = part.replace(/~1/g, "/").replace(/~0/g, "~");
      return SAFE_FIELD.test(name) ? name : "*";
    })
    .map((part) => `/${part}`)
    .join("");
}

// Error messages are fixed sentences built from the schema, never from the
// rejected value, so blocked text cannot leak into logs. The Python package
// builds exactly the same sentences.
function describe(e: ErrorObject): string | null {
  const path = pointer(e.instancePath);
  const p = e.params as Record<string, unknown>;
  if (e.schemaPath.includes("/anyOf/")) return null; // reported once by the anyOf error
  if (e.propertyName !== undefined || e.keyword === "propertyNames") return `${path} has an invalid field name`;
  switch (e.keyword) {
    case "if":
      return null; // the failing "then" branch is reported on its own
    case "not":
      return `${path} is not allowed for this event type`;
    case "additionalProperties":
      return `${path} has an unexpected field ${fieldName(p["additionalProperty"])}`;
    case "required":
      return `${path} is missing the required field '${String(p["missingProperty"])}'`;
    case "type":
      return `${path} must be ${Array.isArray(p["type"]) ? (p["type"] as string[]).join(" or ") : String(p["type"])}`;
    case "enum":
      return `${path} must be one of the allowed values`;
    case "const":
      return `${path} must equal ${JSON.stringify(p["allowedValue"])}`;
    case "pattern":
      return `${path} does not have the expected format`;
    case "format":
      return `${path} must be a valid ${String(p["format"])}`;
    case "minimum":
      return `${path} must be >= ${JSON.stringify(p["limit"])}`;
    case "maximum":
      return `${path} must be <= ${JSON.stringify(p["limit"])}`;
    case "exclusiveMinimum":
      return `${path} must be > ${JSON.stringify(p["limit"])}`;
    case "exclusiveMaximum":
      return `${path} must be < ${JSON.stringify(p["limit"])}`;
    case "minLength":
      return `${path} must have at least ${count(p["limit"], "character")}`;
    case "maxLength":
      return `${path} must have at most ${count(p["limit"], "character")}`;
    case "minItems":
      return `${path} must have at least ${count(p["limit"], "item")}`;
    case "maxItems":
      return `${path} must have at most ${count(p["limit"], "item")}`;
    case "uniqueItems":
      return `${path} must not contain duplicate items`;
    case "minProperties":
      return `${path} must have at least ${count(p["limit"], "field")}`;
    case "maxProperties":
      return `${path} must have at most ${count(p["limit"], "field")}`;
    case "anyOf":
      return `${path} does not match any allowed shape`;
    default:
      return `${path} is invalid (${e.keyword})`;
  }
}

function count(limit: unknown, noun: string): string {
  return `${String(limit)} ${noun}${limit === 1 ? "" : "s"}`;
}

/** Sorted, without duplicates, so both languages produce the same list. */
function tidy(messages: string[]): string[] {
  return [...new Set(messages)].sort();
}

function schemaErrors(validate: ValidateFunction): string[] {
  return tidy((validate.errors ?? []).map(describe).filter((m): m is string => m !== null));
}

/** Deepest nesting of arrays and objects accepted. Real records use at most 6 levels. */
export const MAX_DEPTH = 32;
/** Most values (objects, arrays, strings, numbers, booleans and nulls) in one event. Real events hold about 50. */
export const MAX_EVENT_VALUES = 4_096;
/** Most values in one decisions.lock. The largest real lock holds about 33,000 (isotonic breakpoints). */
export const MAX_LOCK_VALUES = 65_536;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when the text contains no unpaired UTF-16 surrogate, so it is valid Unicode. */
export function isWellFormed(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

// Index just past the string literal that starts at `start`, or text.length
// when the string is never closed.
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) return i + 1;
    i += code === BACKSLASH ? 2 : 1;
  }
  return text.length;
}

// Counts brackets outside strings in one linear pass, before any parser runs,
// so deeply nested input is rejected cheaply in both languages.
function nestingTooDeep(text: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      i = skipString(text, i);
      continue;
    }
    if (code === OPEN_ARRAY || code === OPEN_OBJECT) {
      depth += 1;
      if (depth > MAX_DEPTH) return true;
    } else if (code === CLOSE_ARRAY || code === CLOSE_OBJECT) {
      depth -= 1;
    }
    i += 1;
  }
  return false;
}

// Finds a repeated key in any object. Runs only on text that already parsed,
// so the token structure is known to be valid JSON. Keys are compared after
// decoding escapes, the same way the Python package compares them.
function hasDuplicateKey(text: string): boolean {
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      const end = skipString(text, i);
      const top = stack[stack.length - 1];
      if (top !== undefined && top.keys !== null && top.expectKey) {
        const key = JSON.parse(text.slice(i, end)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end;
      continue;
    }
    if (code === OPEN_OBJECT) {
      stack.push({ keys: new Set(), expectKey: true });
    } else if (code === OPEN_ARRAY) {
      stack.push({ keys: null, expectKey: false });
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      stack.pop();
    } else if (code === COMMA) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.keys !== null) top.expectKey = true;
    }
    i += 1;
  }
  return false;
}

// JSON.parse turns a number too large for a 64-bit float into Infinity.
// Nesting is already limited, so a plain walk is safe.
function hasNonFiniteNumber(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return true;
    } else if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
    } else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) stack.push(child);
    }
  }
  return false;
}

/**
 * Parse JSON exactly as the Python package does: the JSON grammar, at most
 * MAX_DEPTH levels of nesting, no repeated keys, and every number fitting in a
 * 64-bit float. The text must be well-formed Unicode. Problems are reported in
 * the same order as in Python: grammar first, then number range, then repeated keys.
 */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!isWellFormed(text)) return { ok: false, error: "not well-formed Unicode text" };
  if (nestingTooDeep(text)) return { ok: false, error: "nested too deeply" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (hasNonFiniteNumber(value)) return { ok: false, error: "number out of range" };
  if (hasDuplicateKey(text)) return { ok: false, error: "duplicate key" };
  return { ok: true, value };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// Checks done before parsing, in the same order as the Python package.
function precheck(text: string, maxBytes: number): string | null {
  if (!isWellFormed(text)) return "not well-formed Unicode text";
  if (utf8Bytes(text) > maxBytes) return `longer than ${maxBytes} bytes`;
  return null;
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

// True when arrays and objects nest deeper than MAX_DEPTH; a cycle counts as
// endless. Values built in code can share objects, so each object is walked
// again only when it is reached at a deeper level than before.
function tooDeep(value: unknown): boolean {
  const deepest = new Map<object, number>();
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop() as [unknown, number];
    if (item === null || typeof item !== "object") continue;
    if (depth > MAX_DEPTH) return true;
    if ((deepest.get(item) ?? 0) >= depth) continue;
    deepest.set(item, depth);
    for (const child of Array.isArray(item) ? item : Object.values(item)) stack.push([child, depth + 1]);
  }
  return false;
}

interface Size {
  values: number;
  bytes: number;
}

// UTF-8 length of a string, or anything above the limit once it is clearly
// longer. A UTF-8 string is never shorter in bytes than in UTF-16 units.
function textBytes(text: string, limit: number): number {
  return text.length > limit ? limit + 1 : Buffer.byteLength(text, "utf8");
}

// Measures a value as if shared objects were copied out: how many values it
// holds, and how many UTF-8 bytes its strings and field names take. A value
// built in code then costs what the same JSON text would; text that passed the
// size limit always passes here. Stops measuring past either limit. Runs after
// tooDeep, so the recursion is shallow and there are no cycles.
function measure(value: unknown, limits: Size, seen: Map<object, Size>): Size {
  if (typeof value === "string") return { values: 1, bytes: textBytes(value, limits.bytes) };
  if (value === null || typeof value !== "object") return { values: 1, bytes: 0 };
  const known = seen.get(value);
  if (known !== undefined) return known;
  const total: Size = { values: 1, bytes: 0 };
  const record = value as Record<string, unknown>;
  const keys = Array.isArray(value) ? null : Object.keys(record);
  const children: unknown[] = keys === null ? (value as unknown[]) : keys.map((key) => record[key]);
  for (let i = 0; i < children.length; i += 1) {
    const key = keys?.[i];
    if (key !== undefined) total.bytes += textBytes(key, limits.bytes);
    const child = measure(children[i], limits, seen);
    total.values += child.values;
    total.bytes += child.bytes;
    if (total.values > limits.values || total.bytes > limits.bytes) break;
  }
  seen.set(value, total);
  return total;
}

// Checks run before the schema, in the same order as the Python package.
function shapeProblem(value: unknown, limits: Size): string | null {
  if (tooDeep(value)) return "nested too deeply";
  const size = measure(value, limits, new Map());
  if (size.values > limits.values) return "too many values";
  if (size.bytes > limits.bytes) return "too much text";
  return null;
}

const EVENT_LIMITS: Size = { values: MAX_EVENT_VALUES, bytes: MAX_EVENT_BYTES };
const LOCK_LIMITS: Size = { values: MAX_LOCK_VALUES, bytes: MAX_LOCK_BYTES };

/** Validate one event object against events.schema.json. */
export function validateEvent(value: unknown): ValidationResult {
  const problem = shapeProblem(value, EVENT_LIMITS);
  if (problem !== null) return { ok: false, errors: [problem] };
  const validate = eventValidator();
  const ok = validate(value);
  return { ok, errors: ok ? [] : schemaErrors(validate) };
}

/** Parse and validate one event from JSON text. A leading byte order mark is ignored. */
export function validateEventText(text: string): ValidationResult {
  const body = stripBom(text);
  const error = precheck(body, MAX_EVENT_BYTES);
  if (error !== null) return { ok: false, errors: [error] };
  const parsed = parseJson(body);
  return parsed.ok ? validateEvent(parsed.value) : { ok: false, errors: [parsed.error] };
}

/**
 * Validate a whole events.jsonl text. Lines are split on "\n" only, with one
 * trailing "\r" removed, so files written on Windows work. A byte order mark at
 * the start of the file is ignored. Lines holding only spaces or tabs are
 * skipped. Errors are prefixed with the line number.
 */
export function validateEventsJsonl(text: string): ValidationResult & { count: number } {
  const errors: string[] = [];
  let count = 0;
  stripBom(text)
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (/^[ \t]*$/.test(line)) return;
      count += 1;
      const prefix = `line ${index + 1}:`;
      const tooBig = precheck(line, MAX_EVENT_BYTES);
      if (tooBig !== null) {
        errors.push(`${prefix} ${tooBig}`);
        return;
      }
      const parsed = parseJson(line);
      if (!parsed.ok) {
        errors.push(`${prefix} ${parsed.error}`);
        return;
      }
      for (const error of validateEvent(parsed.value).errors) errors.push(`${prefix} ${error}`);
    });
  return { ok: errors.length === 0, errors, count };
}

/**
 * Validate a decisions.lock object: the JSON Schema first, then the rules a
 * schema cannot express (every threshold label is a known label, and unsure
 * never exceeds act).
 */
export function validateLock(value: unknown): ValidationResult {
  const problem = shapeProblem(value, LOCK_LIMITS);
  if (problem !== null) return { ok: false, errors: [problem] };
  const validate = lockValidator();
  if (!validate(value)) return { ok: false, errors: schemaErrors(validate) };
  const lock = value as DecisionsLock;
  const errors: string[] = [];
  for (const [name, decision] of Object.entries(lock.decisions)) {
    if (decision === undefined) continue;
    for (const [label, t] of Object.entries(decision.thresholds)) {
      if (!decision.labels.includes(label)) {
        errors.push(`/decisions/${name}/thresholds/${label} is not one of the labels`);
      }
      if (t.unsure > t.act) {
        errors.push(`/decisions/${name}/thresholds/${label} has unsure above act`);
      }
    }
  }
  return { ok: errors.length === 0, errors: tidy(errors) };
}

/** Parse and validate a decisions.lock from JSON text. A leading byte order mark is ignored. */
export function validateLockText(text: string): ValidationResult {
  const body = stripBom(text);
  const error = precheck(body, MAX_LOCK_BYTES);
  if (error !== null) return { ok: false, errors: [error] };
  const parsed = parseJson(body);
  return parsed.ok ? validateLock(parsed.value) : { ok: false, errors: [parsed.error] };
}
