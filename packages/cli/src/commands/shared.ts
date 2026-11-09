import { ApiClient } from "../client.ts";
import type { CommandContext } from "../command.ts";
import { type Context, resolveContext } from "../config.ts";
import { UsageError } from "../io.ts";

/** The client and identity a command works with, from the repository and credentials. */
export async function connect(
  context: CommandContext,
): Promise<{ client: ApiClient; identity: Context }> {
  const identity = await resolveContext(context.io.env, context.io.cwd, context.role, {
    agent: context.agent,
    fetch: context.io.fetch,
  });
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
    throw new UsageError(`--${name} must be a whole number from ${range.min} to ${range.max}`);
  }
  return n;
}
