#!/usr/bin/env node
// The twosystems command. Part of twosystems, created by Shashikant.
// https://github.com/shashikantdev3/twosystems
//
// If the program itself cannot load (an old Node.js, a broken install), a hook
// call still answers "{}" and exits 0: some agents treat a failing hook as a
// refusal, and a watchman must never block the agent it watches.
const args = process.argv.slice(2);

// Output piped into a command that stops early (such as head) is not an error.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

try {
  const { main } = await import("../dist/src/cli.js");
  process.exitCode = await main(args);
} catch (error) {
  if (args[0] === "hook") {
    process.stdout.write("{}\n");
    process.exitCode = 0;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
