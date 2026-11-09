/** Everything the commands need from the outside world, so tests can replace it. */
export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Standard output (results). */
  out: (text: string) => void;
  /** Standard error (progress, warnings, errors). */
  err: (text: string) => void;
  /** Reads all of standard input. */
  readStdin: () => Promise<string>;
  /** Standard input line by line, until it is closed. */
  readLines: () => AsyncIterable<string>;
  /** Asks a question when running in a terminal; resolves to the default on an empty answer. */
  ask: (question: string, defaultValue?: string) => Promise<string>;
  /** True when a person can answer questions (stdin and stdout are terminals). */
  interactive: boolean;
  fetch: typeof fetch;
}

/** Exit codes. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** `wait` ended without receiving anything. */
  timeout: 3,
} as const;

/** An error that is shown to the user as a single line, without a stack trace. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, options: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? EXIT.error;
    this.hint = options.hint;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, hint === undefined ? { exitCode: EXIT.usage } : { exitCode: EXIT.usage, hint });
    this.name = "UsageError";
  }
}
