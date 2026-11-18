import type { Task } from "@agentbridge/protocol";
import type { Command } from "../command.ts";
import { formatTasks } from "../format.ts";
import { EXIT, UsageError } from "../io.ts";
import { connect, stringValue } from "./shared.ts";

const USAGE =
  "agentbridge task [list] [--all] [--mine]\n" +
  "agentbridge task add <title...> [--part NAME] [--take]\n" +
  "agentbridge task take <number> / leave <number> / done <number>\n" +
  "\n" +
  "The board's tasks and who works on each. Take a task before you start on it (add it first when\n" +
  "it is missing; --take does both) and mark it done when you finish, so everyone sees who does\n" +
  "what. Several agents can work on one task. --part names the part of the project it belongs to.\n" +
  "The list shows open tasks; --all adds the finished ones, --mine shows only yours.";

const ACTIONS = ["take", "leave", "done"] as const;
type Action = (typeof ACTIONS)[number];

const DONE_WORDS: Record<Action, string> = {
  take: "You are on",
  leave: "You left",
  done: "Done:",
};

function taskNumber(given: string | undefined, action: string): number {
  const n = given === undefined ? Number.NaN : Number(given.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(
      `Say which task to ${action}, by its number.`,
      `Usage: agentbridge task ${action} <number>`,
    );
  }
  return n;
}

const line = (t: Task) =>
  `#${t.number} ${t.title}${t.part ? ` [${t.part}]` : ""}${t.agents.length ? ` (${t.agents.join(", ")})` : ""}`;

export const task: Command = {
  name: "task",
  summary: "Take, add and finish the board's tasks",
  usage: USAGE,
  options: {
    all: { type: "boolean" },
    mine: { type: "boolean" },
    part: { type: "string" },
    take: { type: "boolean" },
  },
  async run(context) {
    const { io, values, positionals } = context;
    const [action = "list", ...rest] = positionals;

    if (action === "list") {
      if (rest.length > 0) throw new UsageError("Too many arguments.", USAGE.split("\n")[0]);
      const { client, identity } = await connect(context);
      const all = (await client.tasks()).tasks;
      let list = values.all === true ? all : all.filter((t) => t.state !== "done");
      if (values.mine === true) list = list.filter((t) => t.agents.includes(identity.handle));
      if (context.json) io.out(`${JSON.stringify({ tasks: list })}\n`);
      else if (list.length === 0) {
        io.out(
          values.mine === true
            ? "You are on no task. Take one with: agentbridge task take <number>\n"
            : 'No open tasks. Add one with: agentbridge task add "what needs doing"\n',
        );
      } else io.out(`${formatTasks(list)}\n`);
      return EXIT.ok;
    }

    if (action === "add") {
      const title = rest.join(" ").trim();
      if (!title) {
        throw new UsageError("Say what the task is.", 'Usage: agentbridge task add "title"');
      }
      const part = stringValue(values, "part");
      const { client } = await connect(context);
      const made = await client.addTask({
        title,
        take: values.take === true,
        ...(part ? { part } : {}),
      });
      if (context.json) io.out(`${JSON.stringify(made)}\n`);
      else io.out(`${values.take === true ? "Added and took" : "Added"} ${line(made)}\n`);
      return EXIT.ok;
    }

    if ((ACTIONS as readonly string[]).includes(action)) {
      const act = action as Action;
      if (rest.length > 1) throw new UsageError("Too many arguments.", USAGE.split("\n")[0]);
      const number = taskNumber(rest[0], act);
      const { client } = await connect(context);
      const changed = await client.taskAction(number, act);
      if (context.json) io.out(`${JSON.stringify(changed)}\n`);
      else io.out(`${DONE_WORDS[act]} ${line(changed)}\n`);
      return EXIT.ok;
    }

    throw new UsageError(`Unknown task action "${action}".`, USAGE.split("\n")[0]);
  },
};
