import type { Command } from "../command.ts";
import { formatMessages } from "../format.ts";
import { EXIT } from "../io.ts";
import { connect, integerValue } from "./shared.ts";

export const inbox: Command = {
  name: "inbox",
  summary: "Show messages addressed to you that you have not seen yet",
  usage: "agentbridge inbox [--peek] [--limit N]",
  options: {
    peek: { type: "boolean" },
    limit: { type: "string" },
  },
  async run(context) {
    const { io, values } = context;
    const limit = integerValue(values, "limit", { min: 1, max: 100 });
    const { client } = await connect(context);
    const result = await client.inbox({
      ack: values.peek !== true,
      ...(limit === undefined ? {} : { limit }),
    });

    if (context.json) {
      io.out(`${JSON.stringify(result)}\n`);
      return EXIT.ok;
    }
    if (result.messages.length === 0) {
      io.out("No new messages.\n");
      return EXIT.ok;
    }
    io.out(`${formatMessages(result.messages)}\n`);
    if (result.remaining > 0) io.err(`${result.remaining} more waiting: run the command again.\n`);
    return EXIT.ok;
  },
};
