// Version of this package, read from its package.json. Part of twosystems, created by Shashikant.
import { readFileSync } from "node:fs";

export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;
