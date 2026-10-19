// The portable part of the core must run outside Node (inside Claude Code as a
// plugin), and its hash must match node:crypto exactly.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, sha256Hex } from "../src/hash.js";
import { secureRandom, newId } from "../src/ids.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

test("sha256 matches node:crypto for short, long, empty and non-ASCII text", () => {
  const samples = [
    "",
    "a",
    "abc",
    "twosystems",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(63),
    "x".repeat(64),
    "x".repeat(65),
    "y".repeat(1000),
    "हिंदी और English, 😀 emoji, ü, 中文",
    JSON.stringify({ type: "choice", instructions: "Is it stuck?", criteria: { a: 1 } }),
  ];
  for (const text of samples) {
    assert.equal(sha256(text), `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`, `length ${text.length}`);
  }
  for (let n = 0; n < 200; n++) {
    const bytes = new Uint8Array(n * 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + n) & 0xff;
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
  }
});

test("random numbers fall in [0, 1) and ids are UUIDs", () => {
  for (let i = 0; i < 1000; i++) {
    const r = secureRandom();
    assert.ok(r >= 0 && r < 1);
  }
  assert.match(newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

/** Every module specifier in a file: `from "x"`, `from 'x'`, and side-effect imports. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g)].map((m) => (m[1] ?? m[2]) as string);
}

/** Every file portable.ts reaches through relative imports, as paths relative to src. */
function portableClosure(): string[] {
  const seen = new Set<string>();
  const queue = ["portable.ts"];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(join(SRC, file), "utf8");
    for (const spec of specifiers(text)) {
      if (!spec.startsWith(".")) continue;
      queue.push(normalize(join(dirname(file), spec.replace(/\.js$/, ".ts"))).replaceAll("\\", "/"));
    }
  }
  return [...seen].sort();
}

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the import scan sees every form of import", () => {
  assert.deepEqual(specifiers(`import a from "./a.js";\nimport { b } from './b.js';\nimport "./c.js";\nexport * from "./d.js";`), [
    "./a.js",
    "./b.js",
    "./c.js",
    "./d.js",
  ]);
});

test("the portable core reaches no Node module, package or Node-only global", () => {
  const files = portableClosure();
  assert.ok(files.includes("pipeline.ts") && files.includes("engines/openrouter.ts") && files.includes("receipt.ts"));
  for (const file of files) {
    const text = code(readFileSync(join(SRC, file), "utf8"));
    for (const spec of specifiers(text)) assert.ok(spec.startsWith("."), `${file} imports ${spec}`);
    assert.doesNotMatch(text, /\bimport\(/, `${file} uses a dynamic import`);
    for (const banned of [/\bprocess\./, /\bBuffer\b/, /\brequire\(/, /(?<![.\w])setTimeout\(/, /(?<![.\w])fetch\(/, /\bNodeJS\./]) {
      assert.doesNotMatch(text, banned, `${file} uses ${banned.source}`);
    }
  }
  // Nothing outside src is reached.
  for (const file of files) assert.ok(!relative(SRC, join(SRC, file)).startsWith(".."), file);
});
