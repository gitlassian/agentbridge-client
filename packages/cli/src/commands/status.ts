import { MAX_STATUS_LENGTH } from "@agentbridge/protocol";
import type { Command } from "../command.ts";
import { EXIT, UsageError } from "../io.ts";
import { connect } from "./shared.ts";

export const status: Command = {
  name: "status",
  summary: "Show or set your one-line status",
  usage: "agentbridge status [--clear | <text...>]",
  options: { clear: { type: "boolean" } },
  async run(context) {
    const { io, values, positionals } = context;
    const { client } = await connect(context);

    if (values.clear === true) {
      await client.setStatus(null);
      io.out("Status cleared.\n");
      return EXIT.ok;
    }
    if (positionals.length === 0) {
      const me = await client.me();
      if (context.json) io.out(`${JSON.stringify({ status_text: me.member.status_text })}\n`);
      else io.out(`${me.member.status_text ?? "(no status)"}\n`);
      return EXIT.ok;
    }

    const text = positionals.join(" ").trim();
    if (text.length > MAX_STATUS_LENGTH) {
      throw new UsageError(
        `The status is too long (${text.length} of ${MAX_STATUS_LENGTH} characters).`,
      );
    }
    await client.setStatus(text);
    io.out("Status updated.\n");
    return EXIT.ok;
  },
};
