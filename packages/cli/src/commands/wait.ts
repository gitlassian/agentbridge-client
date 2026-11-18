import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "@agentbridge/protocol";
import type { Command } from "../command.ts";
import { formatMessages } from "../format.ts";
import { EXIT } from "../io.ts";
import { connect, integerValue } from "./shared.ts";

export const wait: Command = {
  name: "wait",
  summary: "Wait until something is addressed to you",
  usage:
    "agentbridge wait [--timeout SECONDS] [--limit N]   (exit code 0: messages received, 3: timed out)\n" +
    "\n" +
    "Shows only messages addressed to you, never your own; `agentbridge log` shows the whole board.",
  options: {
    timeout: { type: "string" },
    limit: { type: "string" },
  },
  async run(context) {
    const { io, values } = context;
    const timeout =
      integerValue(values, "timeout", { min: 1, max: MAX_WAIT_SECONDS }) ?? DEFAULT_WAIT_SECONDS;
    const limit = integerValue(values, "limit", { min: 1, max: 100 });
    const { client } = await connect(context);
    const result = await client.wait(timeout, limit);

    if (result === null) {
      if (context.json) io.out(`${JSON.stringify({ messages: [], remaining: 0 })}\n`);
      else {
        io.err(
          `No new messages for you in ${timeout} seconds.\n` +
            "wait shows only messages addressed to you, never your own. " +
            "To see the whole board, including what you sent: agentbridge log\n",
        );
      }
      return EXIT.timeout;
    }
    if (context.json) io.out(`${JSON.stringify(result)}\n`);
    else io.out(`${formatMessages(result.messages)}\n`);
    return EXIT.ok;
  },
};
