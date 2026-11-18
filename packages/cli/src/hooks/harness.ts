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
  /** How to get the whole of message number `seq` when it was cut short. */
  fullMessage: (seq: number) => string;
  /** How the agent asks its own user for a decision, after "If a person is needed, ". */
  askUser: string;
  /** How to read a shared document in full. */
  readDoc: (name: string) => string;
  /** How to write a short board context and pin it, only if nobody has done it meanwhile. */
  pinDoc: string;
  /** How to save a change to the pinned context without overwriting a teammate's change. */
  updateDoc: string;
  /** How to take a part of the project, and how to see who holds which. */
  claim: string;
  /** How to take a task (or add it), and how to mark it done, after "Before you start work, ". */
  task: string;
  /** How to see the board's tasks. */
  tasks: string;
  /** How to get file number `n` that a message carries. */
  getFile: (number: number) => string;
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
    fullMessage: (seq) => `run \`agentbridge read ${seq}\``,
    askUser:
      "ask your own user with your AskUserQuestion tool, offering the options you see, then post the answer on the board",
    readDoc: (name) => `run \`agentbridge doc read ${name}\``,
    pinDoc:
      "write a short one and pin it with `agentbridge doc write context.md - --base 0 --pin --as agent`",
    updateDoc: "`agentbridge doc write <name> - --base <the version you read> --as agent`",
    claim:
      "run `agentbridge claim <path>... --as agent` (and `agentbridge zones` to see who holds what)",
    task: 'take its task with `agentbridge task take <number> --as agent` (or `agentbridge task add "title" --take --as agent` when it is missing) and run `agentbridge task done <number> --as agent` when you finish',
    tasks: "run `agentbridge task`",
    getFile: (number) => `agentbridge file get ${number}`,
  },
  mcp: {
    howTo:
      "To talk to them use the tools of the agentbridge MCP server: `post` " +
      '(for example "@bob/claude the endpoint is ready"), `inbox`, `wait`, `read`, `members`, `set_status`, ' +
      "`docs`, `read_doc`, `write_doc` for shared documents, `tasks` and `task` for the board's tasks, `send_file`, `files`, `get_file` for files, and `zones`, `claim`, `release` for parts of the project.",
    answer: "with the agentbridge `post` tool",
    more: "use the agentbridge `inbox` tool",
    fullMessage: (seq) => `call the agentbridge \`read\` tool with seq ${seq}`,
    askUser: "ask your own user in your session first, then post the answer on the board",
    readDoc: (name) => `call the agentbridge \`read_doc\` tool with name "${name}"`,
    pinDoc:
      "write a short one with the agentbridge `write_doc` tool, base_version 0 and pinned: true",
    updateDoc: "the agentbridge `write_doc` tool with base_version set to the version you read",
    claim:
      "call the agentbridge `claim` tool with the paths (the `zones` tool shows who holds what)",
    task: "take its task with the agentbridge `task` tool (action take, or add with take: true when it is missing) and finish it there with action done",
    tasks: "call the agentbridge `tasks` tool",
    getFile: (number) => `the agentbridge get_file tool, number ${number}`,
  },
};

export function talkFor(harness: Harness): Talk {
  return harness === "codex" ? TALK.mcp : TALK.cli;
}
