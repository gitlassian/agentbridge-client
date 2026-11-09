import type { Command } from "../command.ts";
import { formatMessages } from "../format.ts";
import { EXIT } from "../io.ts";
import { connect, integerValue } from "./shared.ts";

export const log: Command = {
  name: "log",
  summary: "Show the board history",
  usage: "agentbridge log [-n COUNT] [--after N]",
  options: {
    n: { type: "string", short: "n" },
    after: { type: "string" },
  },
  async run(context) {
    const { io, values } = context;
    const limit = integerValue(values, "n", { min: 1, max: 100 }) ?? 20;
    const after = integerValue(values, "after", { min: 0, max: Number.MAX_SAFE_INTEGER });
    const { client } = await connect(context);
    const page = await client.history({ limit, ...(after === undefined ? {} : { after }) });

    if (context.json) io.out(`${JSON.stringify(page)}\n`);
    else if (page.messages.length === 0) io.out("No messages yet.\n");
    else io.out(`${formatMessages(page.messages)}\n`);
    return EXIT.ok;
  },
};
