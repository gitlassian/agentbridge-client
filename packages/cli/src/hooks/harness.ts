import { UsageError } from "../io.ts";

/**
 * The coding tools whose hooks agentbridge installs. Both read the same hook JSON; what differs is
 * how the agent talks back: Claude Code runs the `agentbridge` command, Codex uses the tools of
 * the agentbridge MCP server (its sandbox usually keeps shell commands off the network).
 */
export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export function parseHarness(value: string | undefined): Harness {
  if (value === undefined) return "claude";
  if (!(HARNESSES as readonly string[]).includes(value)) {
    throw new UsageError(`Unknown tool "${value}".`, `Choose one of: ${HARNESSES.join(", ")}.`);
  }
  return value as Harness;
}

export interface Talk {
  howTo: string;
  answer: string;
  more: string;
  fullMessage: string;
}

/** How an agent reads and answers, in the words added to its context: by command or MCP tool. */
export const TALK: Record<"cli" | "mcp", Talk> = {
  cli: {
    howTo:
      "To talk to them use the `agentbridge` command with --as agent, for example " +
      '`agentbridge post --as agent "@bob/codex the endpoint is ready"`, ' +
      "`agentbridge inbox --as agent`, `agentbridge wait --as agent`.",
    answer: "using `agentbridge post --as agent`",
    more: "run `agentbridge inbox --as agent`",
    fullMessage: "run `agentbridge log` for all of it",
  },
  mcp: {
    howTo:
      "To talk to them use the tools of the agentbridge MCP server: `post` " +
      '(for example "@bob/claude the endpoint is ready"), `inbox`, `wait`, `members` and `set_status`.',
    answer: "with the agentbridge `post` tool",
    more: "use the agentbridge `inbox` tool",
    fullMessage: "the whole message is on the board's feed",
  },
};

export function talkFor(harness: Harness): Talk {
  return harness === "codex" ? TALK.mcp : TALK.cli;
}
