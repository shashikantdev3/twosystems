// Checks that a release tag matches every package version before anything is published.
// Tag v0.1.0-alpha.1 means npm 0.1.0-alpha.1, PyPI 0.1.0a1 (PEP 440), and the Claude Code
// plugin 0.1.0-alpha.1 (its plugin.json and the version its records carry).
// Usage: node scripts/check-release.mjs v0.1.0-alpha.1
// Part of twosystems, created by Shashikant.
import { appendFileSync, readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const match = /^v(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(tag);
if (!match) {
  console.error(`"${tag}" is not a release tag like v0.1.0 or v0.1.0-alpha.1`);
  process.exit(1);
}
const [, core, stage, number] = match;
const npmVersion = stage ? `${core}-${stage}.${number}` : core;
const pep440 = stage ? `${core}${{ alpha: "a", beta: "b", rc: "rc" }[stage]}${number}` : core;

const npmActual = JSON.parse(readFileSync("packages/core/package.json", "utf8")).version;
const pyActual = /^version = "([^"]+)"/m.exec(readFileSync("python/pyproject.toml", "utf8"))?.[1];
const pluginActual = JSON.parse(readFileSync("packages/claude-code/.claude-plugin/plugin.json", "utf8")).version;
const pluginRecords = /VERSION = "([^"]+)"/.exec(readFileSync("packages/claude-code/hooks/plugin/version.ts", "utf8"))?.[1];

let ok = true;
if (npmActual !== npmVersion) {
  console.error(`packages/core/package.json has ${npmActual}, the tag needs ${npmVersion}`);
  ok = false;
}
if (pyActual !== pep440) {
  console.error(`python/pyproject.toml has ${pyActual}, the tag needs ${pep440}`);
  ok = false;
}
if (pluginActual !== npmVersion) {
  console.error(`packages/claude-code/.claude-plugin/plugin.json has ${pluginActual}, the tag needs ${npmVersion}`);
  ok = false;
}
if (pluginRecords !== npmVersion) {
  console.error(`packages/claude-code/hooks/plugin/version.ts has ${pluginRecords}, the tag needs ${npmVersion}`);
  ok = false;
}
if (!ok) process.exit(1);
const distTag = stage ?? "latest";
console.log(`npm ${npmVersion}, PyPI ${pep440} and the Claude Code plugin ${npmVersion} match ${tag}; npm dist-tag ${distTag}`);
// In GitHub Actions, hand the values to later steps.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `npm_version=${npmVersion}\nnpm_tag=${distTag}\npypi_version=${pep440}\n`);
}
