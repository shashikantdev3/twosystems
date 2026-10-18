// Keeps shared files identical across packages. The repository root is the
// single source of truth; packages hold committed copies so each one can be
// published on its own.
//   node scripts/sync-shared.mjs          copy root files into the packages
//   node scripts/sync-shared.mjs --check  fail if any copy is out of date (used in CI)
// Part of twosystems, created by Shashikant.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
];

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

if (check) {
  if (stale.length > 0) {
    console.error("Shared files are out of date. Run `npm run sync` and commit:");
    for (const file of stale) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log(`All ${copies.length} shared copies match the repository root.`);
}
