// The plugin's plain parts: settings, thresholds, answers, text and the log.
// Part of twosystems, created by Shashikant.
import { expect, test } from "claude-code/testing";
import { RulesEngine, builtInLock } from "../hooks/core/portable.js";
import { EventLog, type LogFiles, homeFolder } from "../hooks/plugin/eventlog.js";
import { readSettings, thresholdsFor } from "../hooks/plugin/settings.js";
import { excerpt, receiptLine } from "../hooks/plugin/text.js";
import { askOutcome } from "../hooks/plugin/tracker.js";
import { fileKey } from "./world.js";

test("a refusal counts as stop only in Claude Code's own words", () => {
  expect(askOutcome({ deny: "blocked by a hook" })).toBe("stop");
  expect(
    askOutcome({ isError: true, text: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)." }),
  ).toBe("stop");
  expect(askOutcome({ isError: true, text: "[Request interrupted by user for tool use]" })).toBe("stop");
  // A step the user allowed that then failed is still "keep going".
  expect(askOutcome({ isError: true, text: "UnhandledPromiseRejection: request was rejected by the server; cancelled" })).toBe("keep_going");
  expect(askOutcome({ text: "ok" })).toBe("keep_going");
});

test("settings: auto picks OpenRouter only with a key, and bad values fall back", () => {
  expect(readSettings({}, undefined).engine).toBe("rules");
  expect(readSettings({}, "sk-or-x").engine).toBe("openrouter");
  expect(readSettings({ openrouter_key: "sk-or-y" }, undefined).openRouterKey).toBe("sk-or-y");
  expect(readSettings({ engine: "ollama", model: "nimble" }, "sk").engine).toBe("ollama");
  const odd = readSettings({ engine: "magic", holdout: 0.9, timeout_ms: 50, model: "has space", cache_minutes: "5" }, undefined);
  expect(odd.engine).toBe("rules");
  expect(odd.holdoutRate).toBe(0.1);
  expect(odd.timeoutMs).toBe(5000);
  expect(odd.model).toBe(undefined);
  expect(odd.cacheTtlSeconds).toBe(300);
  expect(readSettings({ hold_new_task_prompts: false, receipt_line: false }, undefined).holdNewTaskPrompts).toBe(false);
});

test("a larger false-alarm budget lowers the thresholds and changes the lock hash", () => {
  const engine = new RulesEngine();
  const low = thresholdsFor(engine, "low");
  const high = thresholdsFor(engine, "high");
  expect(low.hash).toBe(builtInLock(engine.info).hash);
  expect(high.hash).not.toBe(low.hash);
  expect(high.lock.decisions.stuck?.thresholds["stuck"]?.act).toBe(0.75);
  expect(low.lock.decisions.stuck?.thresholds["stuck"]?.act).toBe(0.85);
  for (const decision of Object.values(high.lock.decisions)) {
    for (const limits of Object.values(decision?.thresholds ?? {})) expect(limits.unsure).toBeLessThanOrEqual(limits.act);
  }
});

test("the home folder comes from TWOSYSTEMS_HOME, then a Windows USERPROFILE, then HOME", () => {
  expect(homeFolder({ twosystemsHome: "/data/ts/", home: "/home/dev" })).toBe("/data/ts");
  expect(homeFolder({ home: "/home/dev" })).toBe("/home/dev/.twosystems");
  expect(homeFolder({ userProfile: "C:\\Users\\debna" })).toBe("C:\\Users\\debna/.twosystems");
  // On Windows USERPROFILE wins, as it does for Node and the twosystems command.
  expect(homeFolder({ home: "/c/Users/debna", userProfile: "C:\\Users\\debna" })).toBe("C:\\Users\\debna/.twosystems");
  expect(homeFolder({ home: "C:\\Users\\debna", userProfile: "\\\\server\\users\\debna" })).toBe("\\\\server\\users\\debna/.twosystems");
  // A USERPROFILE forwarded to WSL, Linux or macOS is not the home folder there.
  expect(homeFolder({ home: "/home/dev", userProfile: "/mnt/c/Users/debna" })).toBe("/home/dev/.twosystems");
  expect(homeFolder({ home: "/home/dev", userProfile: "C:\\Users\\debna" })).toBe("/home/dev/.twosystems");
  expect(homeFolder({ home: "/Users/dev", userProfile: "C:\\Users\\debna" })).toBe("/Users/dev/.twosystems");
  expect(homeFolder({})).toBe(null);
});

test("the receipt line says only what happened", () => {
  const quiet = { checks: 0, costUsd: 0, asked: 0, shown: 0 };
  expect(receiptLine(quiet, { checks: 3, costUsd: 0.00003 }, null)).toBe(null);
  expect(receiptLine({ checks: 1, costUsd: 0.00002, asked: 1, shown: 0 }, { checks: 1, costUsd: 0.00002 }, null)).toBe(
    "twosystems: asked before a step (1 check, $0.00002). This session: 1 check, $0.00002.",
  );
  expect(receiptLine(quiet, { checks: 0, costUsd: 0 }, { action: "clear", before: 150_000, after: 9_000 })).toBe(
    "twosystems: after clearing, each request sends about 9k tokens instead of 150k.",
  );
  expect(receiptLine(quiet, { checks: 0, costUsd: 0 }, { action: "clear", before: 9_000, after: 150_000 })).toBe(null);
  expect(excerpt("a\n  b   c")).toBe("a b c");
  expect(excerpt("x".repeat(200)).length).toBe(90);
});

function memoryFiles(): LogFiles & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    write: async (path, text) => {
      files.set(path, text);
    },
    exists: async (path) => files.has(path),
    list: async (dir) =>
      [...files.keys()]
        .filter((path) => path.slice(0, path.lastIndexOf("/")) === dir)
        .map((path) => ({ name: path.slice(dir.length + 1), kind: "file", size: (files.get(path) ?? "").length })),
  };
}

const record = (session: string, n: number) => ({
  v: 1 as const,
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  ts: "2026-10-19T10:00:00.000Z",
  agent: "claude-code" as const,
  session,
  type: "usage" as const,
  usage: { source: "exact" as const, context_tokens: n },
});

test("the log keeps one file per session, appends after what is there, and reads everything back", async () => {
  const io = memoryFiles();
  io.files.set("/h/events.d/claude-code-s1.jsonl", `${JSON.stringify(record("s1", 1))}`);
  io.files.set("/h/events.jsonl", `${JSON.stringify(record("hook", 2))}\nnot json\n`);
  const log = new EventLog("/h");
  await log.append(io, [record("s1", 3), record("s2", 4)]);
  await log.append(io, [record("s1", 5)]);
  expect((io.files.get("/h/events.d/claude-code-s1.jsonl") ?? "").split("\n").filter((l) => l !== "").length).toBe(3);
  expect(io.files.has("/h/events.d/claude-code-s2.jsonl")).toBe(true);
  const all = await log.readAll(io, "/h");
  expect(all.events.map((e) => (e.type === "usage" ? e.usage.context_tokens : 0)).sort()).toEqual([1, 2, 3, 4, 5]);
  expect(all.skipped).toBe(1);
});

test("a write that fails is noted, never thrown", async () => {
  const io = memoryFiles();
  io.write = async () => {
    throw new Error("disk full");
  };
  const log = new EventLog("/h");
  await log.append(io, [record("s1", 1)]);
  expect(log.problems[0] ?? "").toContain("disk full");
});

test("a session's file rolls over into small parts, and a reload carries on from the last part", async () => {
  const io = memoryFiles();
  const log = new EventLog("/h");
  const batch = Array.from({ length: 1500 }, (_, n) => record("s1", n));
  for (let i = 0; i < batch.length; i += 100) await log.append(io, batch.slice(i, i + 100));
  const parts = [...io.files.keys()].filter((p) => p.startsWith("/h/events.d/")).sort();
  expect(parts.length).toBeGreaterThan(1);
  for (const path of parts) expect((io.files.get(path) ?? "").length).toBeLessThanOrEqual(256_000 + 30_000);
  const reloaded = new EventLog("/h");
  await reloaded.append(io, [record("s1", 9999)]);
  const after = [...io.files.keys()].filter((p) => p.startsWith("/h/events.d/")).sort();
  expect(after).toEqual(parts);
  const all = await reloaded.readAll(io, "/h");
  expect(all.events.length).toBe(1501);
  expect(all.skipped).toBe(0);
});

test("files with a byte-order mark or no final newline are read and extended cleanly", async () => {
  const io = memoryFiles();
  io.files.set("/h/events.d/claude-code-s1.jsonl", `\uFEFF${JSON.stringify(record("s1", 1))}`);
  const log = new EventLog("/h");
  await log.append(io, [record("s1", 2)]);
  const text = io.files.get("/h/events.d/claude-code-s1.jsonl") ?? "";
  expect(text.split("\n").filter((l) => l !== "").length).toBe(2);
  expect((await log.readAll(io, "/h")).events.length).toBe(2);
});

test("the test world finds a file however Windows spells its path", () => {
  const key = "/home/dev/.twosystems/events.d/claude-code-s.jsonl";
  expect(fileKey(key)).toBe(key);
  expect(fileKey("\\home\\dev\\.twosystems\\events.d\\claude-code-s.jsonl")).toBe(key);
  expect(fileKey("D:\\home\\dev\\.twosystems\\events.d\\claude-code-s.jsonl")).toBe(key);
  expect(fileKey("D:/a/twosystems/twosystems/home/dev/.twosystems/events.d/claude-code-s.jsonl")).toBe(key);
});
