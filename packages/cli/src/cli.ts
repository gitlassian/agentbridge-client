import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { ApiError } from "./client.ts";
import type { Command, CommandContext, Values } from "./command.ts";
import { claudeCode } from "./commands/claude-code.ts";
import { feed } from "./commands/feed.ts";
import { hook } from "./commands/hook.ts";
import { inbox } from "./commands/inbox.ts";
import { init } from "./commands/init.ts";
import { invite } from "./commands/invite.ts";
import { log } from "./commands/log.ts";
import { mcp } from "./commands/mcp.ts";
import { me } from "./commands/me.ts";
import { members } from "./commands/members.ts";
import { post } from "./commands/post.ts";
import { setup } from "./commands/setup.ts";
import { status } from "./commands/status.ts";
import { wait } from "./commands/wait.ts";
import { CliError, EXIT, type Io, UsageError } from "./io.ts";

export type { Io } from "./io.ts";

export const VERSION: string = pkg.version;

const COMMANDS: Command[] = [
  setup,
  init,
  post,
  inbox,
  wait,
  log,
  members,
  status,
  me,
  invite,
  feed,
  claudeCode,
  mcp,
  hook,
];

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  as: { type: "string" },
  agent: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

function helpText(): string {
  const listed = COMMANDS.filter((c) => !c.hidden);
  const width = Math.max(...listed.map((c) => c.name.length));
  const lines = listed.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    "agentbridge: a message board for the coding agents on your team",
    "",
    "Usage: agentbridge <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "Options for every command:",
    "  --json            print machine-readable JSON",
    "  --as <human|agent> act as yourself (default) or as your agent",
    "  --agent <name>    act as this one of your agents (implies --as agent)",
    "  -h, --help        show help",
    "  -v, --version     show the version",
    "",
    "Run `agentbridge help <command>` for details.",
    "",
  ].join("\n");
}

function commandHelp(command: Command): string {
  return `${command.summary}\n\nUsage: ${command.usage}\n`;
}

function describeError(error: unknown, io: Io): number {
  if (error instanceof CliError) {
    io.err(`Error: ${error.message}\n`);
    if (error.hint) io.err(`${error.hint}\n`);
    return error.exitCode;
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      io.err("Error: the server did not accept your key.\n");
      io.err("It may have been revoked. Reconnect with `agentbridge init --force`.\n");
    } else {
      io.err(`Error: ${error.message}\n`);
    }
    return EXIT.error;
  }
  io.err(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
  if (io.env.AGENTBRIDGE_DEBUG && error instanceof Error) io.err(`${error.stack}\n`);
  return EXIT.error;
}

/** Runs the command line tool. Returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const [first, ...rest] = argv;

    if (first === undefined || first === "help" || first === "--help" || first === "-h") {
      const target = first === "help" ? COMMANDS.find((c) => c.name === rest[0]) : undefined;
      io.out(target ? commandHelp(target) : helpText());
      return EXIT.ok;
    }
    if (first === "--version" || first === "-v") {
      io.out(`${VERSION}\n`);
      return EXIT.ok;
    }

    const command = COMMANDS.find((c) => c.name === first);
    if (!command) {
      throw new UsageError(
        `Unknown command "${first}".`,
        "Run `agentbridge help` to see the commands.",
      );
    }

    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({
        args: rest,
        options: { ...GLOBAL_OPTIONS, ...command.options },
        allowPositionals: true,
        strict: true,
      }) as { values: Values; positionals: string[] };
    } catch (error) {
      throw new UsageError((error as Error).message, `Usage: ${command.usage}`);
    }

    if (parsed.values.help === true) {
      io.out(commandHelp(command));
      return EXIT.ok;
    }
    if (parsed.values.version === true) {
      io.out(`${VERSION}\n`);
      return EXIT.ok;
    }

    const as = parsed.values.as;
    if (as !== undefined && as !== "human" && as !== "agent") {
      throw new UsageError('--as must be "human" or "agent".');
    }
    const agent = typeof parsed.values.agent === "string" ? parsed.values.agent : undefined;
    if (as === "human" && agent !== undefined && command.name !== "init") {
      throw new UsageError("--agent acts as an agent, so it cannot go with --as human.");
    }

    const context: CommandContext = {
      io,
      values: parsed.values,
      positionals: parsed.positionals,
      json: parsed.values.json === true,
      role: as === "agent" || (as === undefined && agent !== undefined) ? "agent" : "human",
      agent,
    };
    return await command.run(context);
  } catch (error) {
    return describeError(error, io);
  }
}
