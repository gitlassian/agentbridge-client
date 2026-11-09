import { stat } from "node:fs/promises";
import { join } from "node:path";
import { backup, codexHome, readText, writeAtomic } from "../claude-code/install.ts";

/**
 * Adds and removes the agentbridge MCP server in Codex's config.toml without touching anything
 * else in it.
 *
 * The file is edited as text, line by line: only our table (and its sub-tables) is written or
 * taken out, so the person's comments, order and formatting stay as they were. Codex itself
 * rewrites the file when it changes a setting (`codex mcp add`, the settings screen), dropping
 * comments, so our table is recognised by what it runs (`... mcp --agent codex`), not by a
 * comment. The comment above it is only there for the person reading the file.
 */

export const TOML_MARKER = "# agentbridge-managed";

/** Codex's default tool timeout is 60 s; `wait` blocks for up to 55 s plus the network. */
export const MCP_TOOL_TIMEOUT_SECONDS = 120;

/** The arguments our server ends with; they identify our table. */
const OUR_ARGS = ["mcp", "--agent", "codex"];

export function codexConfigFile(env: NodeJS.ProcessEnv): string {
  return join(codexHome(env), "config.toml");
}

/** TOML basic string. */
const quote = (value: string) => JSON.stringify(value);

function server(command: string): { program: string; args: string[] } {
  const [program = "agentbridge", ...rest] = command.trim().split(/\s+/);
  return { program, args: [...rest, ...OUR_ARGS] };
}

/** The table we want, for `agentbridge` run as `command` (which may carry its own arguments). */
export function mcpBlock(command: string): string {
  const { program, args } = server(command);
  return [
    `${TOML_MARKER}: the agentbridge MCP server (agentbridge setup --remove takes it out)`,
    "[mcp_servers.agentbridge]",
    `command = ${quote(program)}`,
    `args = [${args.map(quote).join(", ")}]`,
    `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SECONDS}`,
  ].join("\n");
}

const HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:agentbridge|"agentbridge"|'agentbridge')\s*(\.|\])/;
const TOP_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:agentbridge|"agentbridge"|'agentbridge')\s*\]/;
const ANY_HEADER = /^\s*\[/;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;
/** agentbridge defined some other way: dotted keys or an inline table under [mcp_servers]. */
const OTHER_FORMS = [
  /^\s*mcp_servers\s*\.\s*["']?agentbridge["']?\s*[.=]/m,
  /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$[\s\S]*?^\s*["']?agentbridge["']?\s*[.=]/m,
];

export type McpState = "missing" | "current" | "outdated" | "foreign";

/** The plain `key = value` lines of a table (values that span lines are not needed here). */
function keysOf(lines: string[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (match?.[1] !== undefined && match[2] !== undefined) keys.set(match[1], match[2]);
  }
  return keys;
}

/** A TOML string or array of strings, as written by us or by Codex; undefined otherwise. */
function parseValue(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value.replace(/'([^'\\]*)'/g, (_m, inner: string) => JSON.stringify(inner)));
  } catch {
    return undefined;
  }
}

function isOurs(table: string[]): boolean {
  const args = parseValue(keysOf(table).get("args"));
  return (
    Array.isArray(args) &&
    args.length >= OUR_ARGS.length &&
    OUR_ARGS.every((arg, i) => args[args.length - OUR_ARGS.length + i] === arg)
  );
}

function isCurrent(table: string[], command: string): boolean {
  const keys = keysOf(table);
  const wanted = server(command);
  return (
    parseValue(keys.get("command")) === wanted.program &&
    JSON.stringify(parseValue(keys.get("args"))) === JSON.stringify(wanted.args) &&
    Number(keys.get("tool_timeout_sec")) === MCP_TOOL_TIMEOUT_SECONDS
  );
}

interface Located {
  /** Our block: [start, end) line indexes, marker comment included when it is there. */
  ours: [number, number] | null;
  /** Our table itself: [header, end). */
  table: [number, number] | null;
  /** agentbridge is configured, but not by us. */
  foreign: boolean;
}

function locate(lines: string[]): Located {
  for (let i = 0; i < lines.length; i++) {
    if (!TOP_HEADER.test(lines[i] ?? "")) continue;
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end] ?? "";
      if (ANY_HEADER.test(next) && !HEADER.test(next)) break;
      end++;
    }
    // Blank lines and the comments above the next table are not part of ours.
    while (end > i + 1 && BLANK_OR_COMMENT.test(lines[end - 1] ?? "")) end--;
    const table = lines.slice(i, end);
    if (!isOurs(table)) return { ours: null, table: null, foreign: true };
    const marked = i > 0 && (lines[i - 1] ?? "").trim().startsWith(TOML_MARKER);
    return { ours: [marked ? i - 1 : i, end], table: [i, end], foreign: false };
  }
  return {
    ours: null,
    table: null,
    foreign:
      lines.some((line) => HEADER.test(line)) ||
      OTHER_FORMS.some((form) => form.test(lines.join("\n"))),
  };
}

const splitLines = (text: string) => text.replace(/\r\n/g, "\n").split("\n");

export function mcpState(text: string | null, command: string): McpState {
  if (text === null) return "missing";
  const lines = splitLines(text);
  const { table, foreign } = locate(lines);
  if (foreign) return "foreign";
  if (table === null) return "missing";
  return isCurrent(lines.slice(table[0], table[1]), command) ? "current" : "outdated";
}

/** The file with our table added or brought up to date. Unchanged when it is foreign or current. */
export function withMcp(text: string | null, command: string): string {
  const current = text ?? "";
  const state = mcpState(text, command);
  if (state === "foreign" || state === "current") return current;
  const lines = splitLines(current);
  const { ours } = locate(lines);
  if (ours !== null) {
    lines.splice(ours[0], ours[1] - ours[0], ...mcpBlock(command).split("\n"));
    return lines.join("\n");
  }
  const body = current.replace(/\s+$/, "");
  return `${body === "" ? "" : `${body}\n\n`}${mcpBlock(command)}\n`;
}

/** The file without our table (and without the blank line that separated it). */
export function withoutMcp(text: string): { text: string; removed: boolean } {
  const lines = splitLines(text);
  const { ours } = locate(lines);
  if (ours === null) return { text, removed: false };
  let [start, end] = ours;
  if (start > 0 && (lines[start - 1] ?? "").trim() === "") start--;
  else if ((lines[end] ?? "").trim() === "" && end < lines.length - 1) end++;
  lines.splice(start, end - start);
  return { text: lines.join("\n"), removed: true };
}

export interface McpReport {
  file: string;
  /** What was there before this run. */
  state: McpState;
  /** Copy of the file as it was just before the change, if it existed and changed. */
  backup: string | null;
  dryRun: boolean;
}

export async function installCodexMcp(
  env: NodeJS.ProcessEnv,
  options: { command: string; dryRun: boolean },
): Promise<McpReport> {
  const file = codexConfigFile(env);
  const text = await readText(file);
  const state = mcpState(text, options.command);
  const report: McpReport = { file, state, backup: null, dryRun: options.dryRun };
  if (state === "foreign" || state === "current" || options.dryRun) return report;
  if (text !== null) report.backup = await backup(env, file);
  // config.toml can hold tokens: keep its permissions, and create it private.
  const mode = text === null ? 0o600 : (await stat(file)).mode & 0o777;
  await writeAtomic(file, withMcp(text, options.command), mode);
  return report;
}

export async function removeCodexMcp(
  env: NodeJS.ProcessEnv,
): Promise<{ file: string; removed: boolean; backup: string | null }> {
  const file = codexConfigFile(env);
  const text = await readText(file);
  if (text === null) return { file, removed: false, backup: null };
  const result = withoutMcp(text);
  if (!result.removed) return { file, removed: false, backup: null };
  const saved = await backup(env, file);
  await writeAtomic(file, result.text, (await stat(file)).mode & 0o777);
  return { file, removed: true, backup: saved };
}

export async function codexMcpState(env: NodeJS.ProcessEnv, command: string): Promise<McpState> {
  return mcpState(await readText(codexConfigFile(env)), command);
}
