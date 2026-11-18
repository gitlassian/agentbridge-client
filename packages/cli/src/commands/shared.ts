import { isAbsolute, relative, resolve } from "node:path";
import { ApiClient } from "../client.ts";
import type { CommandContext } from "../command.ts";
import { type Context, findRepoConfig, resolveContext } from "../config.ts";
import { noteSessionFolder } from "../hooks/session.ts";
import { CliError, type Io, UsageError } from "../io.ts";
import { personAtTerminal } from "../transfer.ts";

/** The client and identity a command works with, from the repository and credentials. */
export async function connect(
  context: CommandContext,
): Promise<{ client: ApiClient; identity: Context }> {
  const identity = await resolveContext(context.io.env, context.io.cwd, context.role, {
    agent: context.agent,
    fetch: context.io.fetch,
  });
  // Run by a coding agent: its hooks follow it to this board (see hooks/session.ts).
  await noteSessionFolder(context.io.env, context.io.cwd);
  if (identity.registered) {
    context.io.err(`Added your agent ${identity.handle} to board "${identity.boardName}".\n`);
  }
  return { client: new ApiClient(identity.server, identity.apiKey, context.io.fetch), identity };
}

export function stringValue(values: CommandContext["values"], name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function integerValue(
  values: CommandContext["values"],
  name: string,
  range: { min: number; max: number },
): number | undefined {
  const raw = stringValue(values, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    const option = name.length === 1 ? `-${name}` : `--${name}`;
    throw new UsageError(`${option} must be a whole number from ${range.min} to ${range.max}`);
  }
  return n;
}

/**
 * Paths as the board knows them: relative to the repository root, with forward slashes. People
 * type paths relative to the folder they stand in, so `claim src` inside `web/` means `web/src`.
 */
export async function repoPaths(context: CommandContext, given: string[]): Promise<string[]> {
  const { cwd } = context.io;
  const root = (await findRepoConfig(cwd))?.dir ?? cwd;
  return given.map((path) => {
    const inside = relative(root, resolve(cwd, path)).split("\\").join("/");
    if (inside === "" || inside === ".") {
      throw new UsageError(
        "That is the whole repository.",
        "Claim a part of it: a directory, a file or a glob such as web/checkout/**.",
      );
    }
    if (inside === ".." || inside.startsWith("../") || isAbsolute(inside)) {
      throw new UsageError(`"${path}" is outside the repository.`);
    }
    return inside;
  });
}

/**
 * Refuses unless a person types the command in their own terminal: letting people onto a board,
 * taking them off it and stopping links are a person's decisions, never an agent's. An agent
 * runs commands with its person's key by default, so the key alone cannot tell them apart.
 */
export function requirePerson(io: Io, command: string): void {
  if (!personAtTerminal(io)) {
    throw new CliError("Only a person can do this, in their own terminal.", {
      hint: `If you are a coding agent: ask your user to run \`${command}\`.`,
    });
  }
}
