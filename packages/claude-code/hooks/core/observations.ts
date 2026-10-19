// Turning what an agent did into short, redacted observations: shared by the
// hook command and the Claude Code plugin.
// Part of twosystems, created by Shashikant.
import { redact } from "./redact.js";
import type { Observation } from "./signals.js";

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** How much of a session is kept between calls, and how long each text may be. */
export const OBSERVATION_LIMITS = { observations: 80, textChars: 400 } as const;

const EDIT_WORD = /edit|write|patch|create|replace|insert|delete|rename|move/i;
const NOT_EDIT = /todo|read|search|list|get|fetch|view/i;

/** True for tools that change files: Edit, Write, editFiles, apply_patch and the like. MCP tools are not counted. */
export function isEditTool(name: string): boolean {
  if (/^mcp/i.test(name)) return false;
  return EDIT_WORD.test(name) && !NOT_EDIT.test(name);
}

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file", "filename"];

/** Files an editing tool call names in its input; other tools give none. */
export function toolFiles(toolName: string | undefined, input: Json | undefined): string[] | undefined {
  if (toolName === undefined || !isEditTool(toolName)) return undefined;
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input?.[key];
    if (typeof value === "string") found.push(value);
  }
  const many = input?.["files"] ?? input?.["paths"];
  if (Array.isArray(many)) for (const f of many) if (typeof f === "string") found.push(f);
  return found.length > 0 ? found : ["(unnamed file)"];
}

/** The command a tool call runs, under any of the field names agents use. */
export function toolCommand(input: Json | undefined): string | undefined {
  return str(input?.["command"]) ?? str(input?.["cmd"]) ?? str(input?.["commandLine"]) ?? str(input?.["script"]);
}

/** Redact and shorten text for storage. Line breaks are kept, so error lines stay apart. */
export function shorten(text: string): string {
  const clean = redact(text.slice(0, OBSERVATION_LIMITS.textChars * 4));
  return clean.length <= OBSERVATION_LIMITS.textChars ? clean : `${clean.slice(0, OBSERVATION_LIMITS.textChars - 3)}...`;
}

/** Copy an observation with its text redacted and shortened, ready to be stored. */
export function storable(observation: Observation): Observation {
  if (observation.kind === "prompt") return { ...observation, text: shorten(observation.text) };
  if (observation.kind === "tool") {
    const copy = { ...observation };
    copy.tool = shorten(observation.tool).slice(0, 80);
    if (observation.command !== undefined) copy.command = shorten(observation.command);
    if (observation.error !== undefined) copy.error = shorten(observation.error);
    if (observation.files !== undefined) copy.files = observation.files.slice(0, 20).map(shorten);
    return copy;
  }
  return { ...observation };
}

/** Add an observation to a list, redacted, in time order, keeping only the newest. */
export function rememberIn(list: Observation[], observation: Observation): void {
  list.push(storable(observation));
  list.sort((a, b) => a.at - b.at);
  if (list.length > OBSERVATION_LIMITS.observations) list.splice(0, list.length - OBSERVATION_LIMITS.observations);
}
