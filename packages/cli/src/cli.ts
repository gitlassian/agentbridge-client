import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { ApiError } from "./client.ts";
import type { Command, CommandContext, Values } from "./command.ts";
import { claim } from "./commands/claim.ts";
import { claudeCode } from "./commands/claude-code.ts";
import { config } from "./commands/config.ts";
import { doc } from "./commands/doc.ts";
import { feed } from "./commands/feed.ts";
import { file } from "./commands/file.ts";
import { hook } from "./commands/hook.ts";
import { inbox } from "./commands/inbox.ts";
import { init } from "./commands/init.ts";
import { invite } from "./commands/invite.ts";
import { log } from "./commands/log.ts";
import { mcp } from "./commands/mcp.ts";
import { me } from "./commands/me.ts";
import { members } from "./commands/members.ts";
import { accept, audit, decline, leave, links, owner, remove, revoke } from "./commands/people.ts";
import { post } from "./commands/post.ts";
import { read } from "./commands/read.ts";
import { release } from "./commands/release.ts";
import { setup } from "./commands/setup.ts";
import { status } from "./commands/status.ts";
import { task } from "./commands/task.ts";
import { wait } from "./commands/wait.ts";
import { zones } from "./commands/zones.ts";
import { CliError, EXIT, type Io, UsageError } from "./io.ts";
import { printable } from "./printable.ts";

export type { Io } from "./io.ts";

export const VERSION: string = pkg.version;

const COMMANDS: Command[] = [
  setup,
  init,
  post,
  inbox,
  wait,
  read,
  log,
  doc,
  claim,
  release,
  zones,
  task,
  file,
  members,
  status,
  me,
  invite,
  links,
  revoke,
  accept,
  decline,
  remove,
  leave,
  owner,
  audit,
  feed,
  config,
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
    if (error.code === "pending") {
      io.err(`Error: ${error.message}.\n`);
      io.err(
        "You can use the board once they let you in; they run `agentbridge accept` for you.\n",
      );
      return EXIT.error;
    }
    if (error.code === "removed") {
      io.err("Error: you are no longer on this board: you left it, or its owner took you off.\n");
      io.err(
        "To come back, ask the owner for an invite and run `agentbridge init --join <invite link>`.\n",
      );
      return EXIT.error;
    }
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

/**
 * The same `io` for output that a person reads in a terminal. Everything a command prints goes
 * through here once, so that no command has to remember which of its text came from the board.
 *
 * Results are cleaned only when they go to a terminal (`io.terminal`) and are text: JSON for a
 * script, the output of a command that speaks a protocol, and anything an agent or a script reads
 * through a pipe stay exact, so a document read and written back keeps every character. Errors
 * are cleaned, except from a command that speaks a protocol: the wake hook hands an agent its
 * messages on standard error.
 */
function forReading(io: Io, options: { json: boolean; protocol: boolean }): Io {
  const exactOut = options.json || options.protocol || io.terminal !== true;
  return {
    ...io,
    out: exactOut ? io.out : (text) => io.out(printable(text)),
    err: options.protocol ? io.err : (text) => io.err(printable(text)),
  };
}

/** Commands that talk to a program, not to a person: their output is a protocol. */
const SPEAKS_A_PROTOCOL = new Set(["mcp", "hook"]);

/** Runs the command line tool. Returns the process exit code. */
export async function run(argv: string[], terminal: Io): Promise<number> {
  // Until the command and its options are known, only errors can carry text from elsewhere.
  let io = forReading(terminal, { json: true, protocol: false });
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
      // Node adds how to pass a text that starts with a dash; the usage below says enough.
      const message = (error as Error).message.replace(
        /\. To specify a positional argument.*$/s,
        ".",
      );
      throw new UsageError(message, `Usage: ${command.usage}`);
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

    io = forReading(terminal, {
      json: parsed.values.json === true,
      protocol: SPEAKS_A_PROTOCOL.has(command.name),
    });
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
