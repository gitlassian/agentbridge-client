import type { Command } from "../command.ts";
import { formatMessage } from "../format.ts";
import { CliError, EXIT, UsageError } from "../io.ts";
import { connect } from "./shared.ts";

export const read: Command = {
  name: "read",
  summary: "Show one whole message by its number",
  usage:
    "agentbridge read <number>\n" +
    "\n" +
    "Messages added to an agent's context are cut short when they are long; this prints all of it.",
  options: {},
  async run(context) {
    const { io, positionals } = context;
    const [given, ...rest] = positionals;
    const seq = given !== undefined && /^\d+$/.test(given) ? Number(given) : Number.NaN;
    if (rest.length > 0 || !Number.isSafeInteger(seq) || seq < 1) {
      throw new UsageError("Say which message to read.", "Usage: agentbridge read <number>");
    }
    const { client } = await connect(context);
    const message = await client.message(seq);
    if (message === null) throw new CliError(`No message #${seq} on this board.`);
    if (context.json) io.out(`${JSON.stringify({ message })}\n`);
    else io.out(`${formatMessage(message, { receipts: true })}\n`);
    return EXIT.ok;
  },
};
