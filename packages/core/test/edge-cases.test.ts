// Edge cases shared with the Python package. Each case is raw text, so each
// language uses its own JSON parser; the expected verdict and the exact list of
// error messages are the contract.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateEventText, validateEventsJsonl, validateLockText } from "../src/index.js";

interface EdgeCase {
  name: string;
  kind: "event" | "lock" | "jsonl";
  text: string;
  valid: boolean;
  count?: number;
  errors: string[];
}

// Update this number together with edge-cases.json, so a truncated file fails.
const EXPECTED_CASES = 193;

const cases = JSON.parse(
  readFileSync(new URL("../../../../schemas/examples/edge-cases.json", import.meta.url), "utf8"),
) as EdgeCase[];

test("all shared edge cases are present", () => {
  assert.equal(cases.length, EXPECTED_CASES);
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length, "case names must be unique");
});

for (const c of cases) {
  test(`edge case: ${c.name}`, () => {
    if (c.kind === "jsonl") {
      const result = validateEventsJsonl(c.text);
      assert.equal(result.ok, c.valid, JSON.stringify(result.errors));
      assert.equal(result.count, c.count);
      assert.deepEqual(result.errors, c.errors);
    } else {
      const result = c.kind === "event" ? validateEventText(c.text) : validateLockText(c.text);
      assert.equal(result.ok, c.valid, JSON.stringify(result.errors));
      assert.deepEqual(result.errors, c.errors);
    }
  });
}
