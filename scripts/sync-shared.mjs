// Keeps shared files identical across packages. The repository root is the
// single source of truth; packages hold committed copies so each one can be
// published on its own. The Claude Code plugin also carries a copy of the
// portable core (packages/core/src/portable.ts and every file it imports),
// because a plugin installs from its own folder and runs without Node.
//   node scripts/sync-shared.mjs          copy root files into the packages
//   node scripts/sync-shared.mjs --check  fail if any copy is out of date (used in CI)
// Part of twosystems, created by Shashikant.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const copies = [
  ["LICENSE", "packages/core/LICENSE"],
  ["NOTICE", "packages/core/NOTICE"],
  ["schemas/events.schema.json", "packages/core/schemas/events.schema.json"],
  ["schemas/decisions-lock.schema.json", "packages/core/schemas/decisions-lock.schema.json"],
  ["LICENSE", "python/LICENSE"],
  ["NOTICE", "python/NOTICE"],
  ["schemas/events.schema.json", "python/src/twosystems/schemas/events.schema.json"],
  ["schemas/decisions-lock.schema.json", "python/src/twosystems/schemas/decisions-lock.schema.json"],
  ["LICENSE", "packages/claude-code/LICENSE"],
  ["NOTICE", "packages/claude-code/NOTICE"],
];

// The portable core: portable.ts and everything it reaches through relative imports.
const CORE_SRC = "packages/core/src";
const PLUGIN_CORE = "packages/claude-code/hooks/core";
function portableClosure() {
  const seen = new Set();
  const queue = ["portable.ts"];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(join(root, CORE_SRC, file), "utf8");
    // Every specifier: `from "x"` or `from 'x'`, and side-effect imports such as `import "x"`.
    for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\s*\(/g)) {
      if (match[0].endsWith("(")) throw new Error(`${file} uses a dynamic import; the portable core may not`);
      const spec = match[1] ?? match[2];
      if (!spec.startsWith(".")) throw new Error(`${file} imports ${spec}; the portable core may import only its own files`);
      queue.push(normalize(join(dirname(file), spec.replace(/\.js$/, ".ts"))).replaceAll("\\", "/"));
    }
  }
  return [...seen].sort();
}
const portable = portableClosure();
for (const file of portable) copies.push([`${CORE_SRC}/${file}`, `${PLUGIN_CORE}/${file}`]);

// Files in the plugin's copy that the portable core no longer has.
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
const extra = listFiles(join(root, PLUGIN_CORE))
  .map((path) => relative(join(root, PLUGIN_CORE), path).replaceAll("\\", "/"))
  .filter((file) => !portable.includes(file));

const check = process.argv.includes("--check");
const stale = [];

for (const [from, to] of copies) {
  const source = readFileSync(join(root, from));
  const target = join(root, to);
  const current = existsSync(target) ? readFileSync(target) : null;
  if (current !== null && current.equals(source)) continue;
  if (check) {
    stale.push(to);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    console.log(`updated ${to}`);
  }
}

for (const file of extra) {
  if (check) {
    stale.push(`${PLUGIN_CORE}/${file} (no longer part of the portable core)`);
  } else {
    rmSync(join(root, PLUGIN_CORE, file));
    console.log(`removed ${PLUGIN_CORE}/${file}`);
  }
}

if (check) {
  if (stale.length > 0) {
    console.error("Shared files are out of date. Run `npm run sync` and commit:");
    for (const file of stale) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log(`All ${copies.length} shared copies match the repository root.`);
}
