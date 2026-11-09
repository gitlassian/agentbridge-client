import type { ParseArgsConfig } from "node:util";
import type { Role } from "./config.ts";
import type { Io } from "./io.ts";

export type Values = Record<string, string | boolean | Array<string | boolean> | undefined>;

export interface CommandContext {
  io: Io;
  values: Values;
  positionals: string[];
  /** Print machine-readable JSON instead of text. */
  json: boolean;
  /** Which identity the command acts as. */
  role: Role;
  /** Which of the person's agents, when `--agent <name>` was given. */
  agent?: string | undefined;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  /** Not listed in the general help. */
  hidden?: boolean;
  run: (context: CommandContext) => Promise<number>;
}
