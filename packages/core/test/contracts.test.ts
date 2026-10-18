// Contract tests: the shared examples in /schemas/examples must behave the
// same here as in the Python package.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION, validateEvent, validateEventsJsonl, validateLock, validateLockText } from "../src/index.js";

const examples = new URL("../../../../schemas/examples/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, examples), "utf8");

interface InvalidEvent {
  why: string;
  path: string;
  record: unknown;
}
interface InvalidLock {
  why: string;
  path: string;
  lock: unknown;
}

test("every valid example event passes", () => {
  const result = validateEventsJsonl(read("events.example.jsonl"));
  assert.deepEqual(result.errors, []);
  assert.equal(result.count, 6);
});

test("every invalid example event is rejected at the expected field", () => {
  const cases = JSON.parse(read("invalid-events.json")) as InvalidEvent[];
  assert.equal(cases.length, 14);
  for (const c of cases) {
    const result = validateEvent(c.record);
    assert.equal(result.ok, false, `accepted: ${c.why}`);
    assert.ok(
      result.errors.some((e) => e.startsWith(`${c.path} `)),
      `${c.why}: expected an error at ${c.path}, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("a line that is not JSON is reported with its line number", () => {
  const result = validateEventsJsonl('\n{"v":1\n');
  assert.equal(result.ok, false);
  assert.equal(result.errors[0], "line 2: not valid JSON");
});

test("the example lock passes", () => {
  assert.deepEqual(validateLock(JSON.parse(read("decisions.lock.example.json"))).errors, []);
});

test("every invalid example lock is rejected at the expected field", () => {
  const cases = JSON.parse(read("invalid-locks.json")) as InvalidLock[];
  assert.equal(cases.length, 5);
  for (const c of cases) {
    const result = validateLock(c.lock);
    assert.equal(result.ok, false, `accepted: ${c.why}`);
    assert.ok(
      result.errors.some((e) => e.startsWith(`${c.path} `)),
      `${c.why}: expected an error at ${c.path}, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("error messages name the offending field", () => {
  const cases = JSON.parse(read("invalid-events.json")) as InvalidEvent[];
  const prompt = cases.find((c) => c.why.startsWith("unknown top-level field"));
  assert.match(validateEvent(prompt?.record).errors.join(" "), /unexpected field 'prompt'/);
  const missing = cases.find((c) => c.why === "missing session");
  assert.match(validateEvent(missing?.record).errors.join(" "), /missing the required field 'session'/);
});

test("VERSION comes from package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});

const usageEvent = (): Record<string, Record<string, unknown>> =>
  JSON.parse(read("events.example.jsonl").split("\n")[0] ?? "") as Record<string, Record<string, unknown>>;

test("numbers that JSON cannot hold are rejected", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const event = usageEvent();
    (event["usage"] as Record<string, unknown>)["input_tokens"] = bad;
    assert.deepEqual(validateEvent(event).errors, ["/usage/input_tokens must be integer"]);
  }
});

test("deep or cyclic objects are rejected without crashing", () => {
  let deep: unknown[] = [];
  for (let i = 0; i < 5000; i += 1) deep = [deep];
  const event = usageEvent();
  (event["usage"] as Record<string, unknown>)["input_tokens"] = deep;
  assert.deepEqual(validateEvent(event).errors, ["nested too deeply"]);
  const cyclic = usageEvent();
  (cyclic["usage"] as Record<string, unknown>)["self"] = cyclic;
  assert.deepEqual(validateEvent(cyclic).errors, ["nested too deeply"]);
  assert.deepEqual(validateLock(deep).errors, ["nested too deeply"]);
});

// Each level holds the level below twice, so the value expands to 2 ** levels leaves.
function shared(levels: number): unknown {
  let value: unknown = "s";
  for (let i = 0; i < levels; i += 1) value = [value, value];
  return value;
}

test("shared objects are checked in linear time", () => {
  const started = performance.now();
  assert.deepEqual(validateEvent(shared(30)).errors, ["too many values"]);
  assert.deepEqual(validateEvent(shared(40)).errors, ["nested too deeply"]);
  for (const [field, value] of [["signals", [shared(25)]], ["probabilities", { a: shared(25) }]] as const) {
    const event = JSON.parse(read("events.example.jsonl").split("\n")[1] ?? "") as { decision: Record<string, unknown> };
    event.decision[field] = value;
    assert.deepEqual(validateEvent(event).errors, ["too many values"]);
  }
  const lock = JSON.parse(read("decisions.lock.example.json")) as {
    holdout_rate: unknown;
    decisions: { stuck: { labels: unknown[] } };
  };
  lock.holdout_rate = shared(22);
  assert.deepEqual(validateLock(lock).errors, ["too many values"]);
  lock.holdout_rate = 0.1;
  lock.decisions.stuck.labels = [shared(24), "b"];
  assert.deepEqual(validateLock(lock).errors, ["too many values"]);
  const small = usageEvent();
  (small["usage"] as Record<string, unknown>)["input_tokens"] = shared(8);
  assert.deepEqual(validateEvent(small).errors, ["/usage/input_tokens must be integer"]);
  assert.ok(performance.now() - started < 5000);
});

test("large arrays of mixed items are checked in linear time", () => {
  const lock = JSON.parse(read("decisions.lock.example.json")) as {
    decisions: { stuck: { labels: unknown[] } };
  };
  lock.decisions.stuck.labels = ["", ...Array.from({ length: 20000 }, (_, i) => i), 0];
  const started = performance.now();
  assert.ok(validateLock(lock).errors.includes("/decisions/stuck/labels must not contain duplicate items"));
  assert.ok(performance.now() - started < 5000);
});

// Number of values in a JSON value, leaving out one top-level field's contents.
function count(value: unknown, without = ""): number {
  if (Array.isArray(value)) return 1 + value.reduce((sum: number, item) => sum + count(item), 0);
  if (value !== null && typeof value === "object") {
    return 1 + Object.entries(value).reduce((sum, [key, item]) => sum + (key === without ? 1 : count(item)), 0);
  }
  return 1;
}

test("a lock may hold at most 65536 values", () => {
  const lock = JSON.parse(read("decisions.lock.example.json")) as Record<string, unknown>;
  lock["extra"] = [];
  const others = count(lock, "extra");
  for (const [total, expected] of [
    [65536, ["<root> has an unexpected field 'extra'"]],
    [65537, ["too many values"]],
  ] as const) {
    lock["extra"] = new Array<number>(total - others).fill(0);
    assert.equal(count(lock), total);
    assert.deepEqual(validateLockText(JSON.stringify(lock)).errors, expected);
  }
});

test("long strings shared in many places are rejected quickly", () => {
  const big = "x".repeat(262_144);
  const started = performance.now();
  assert.deepEqual(validateEvent(new Array<string>(4000).fill(big)).errors, ["too much text"]);
  const lock = JSON.parse(read("decisions.lock.example.json")) as {
    created_by: string;
    decisions: { stuck: { labels: unknown[] } };
  };
  lock.decisions.stuck.labels = Array.from({ length: 16000 }, (_, i) => ({ k: big, i }));
  assert.deepEqual(validateLock(lock).errors, ["too much text"]);
  lock.decisions.stuck.labels = ["progressing", "stuck"];
  lock.created_by = "é".repeat(200);
  assert.deepEqual(validateLock(lock).errors, []);
  assert.ok(performance.now() - started < 5000);
});
