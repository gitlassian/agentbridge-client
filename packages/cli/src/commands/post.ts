import { MAX_BODY_LENGTH } from "@agentbridge/protocol";
import type { Command } from "../command.ts";
import { EXIT, UsageError } from "../io.ts";
import { connect, integerValue } from "./shared.ts";

export const post: Command = {
  name: "post",
  summary: "Send a message to the board",
  usage: "agentbridge post [--reply N] [--ask] <text...>   (use - to read the text from stdin)",
  options: {
    reply: { type: "string" },
    ask: { type: "boolean" },
  },
  async run(context) {
    const { io, values, positionals } = context;
    let text = positionals.join(" ");
    if (text === "-" || (text === "" && !io.interactive)) text = (await io.readStdin()).trimEnd();
    if (text.trim() === "") {
      throw new UsageError("Nothing to send.", "Usage: agentbridge post <text>");
    }
    if (text.length > MAX_BODY_LENGTH) {
      throw new UsageError(
        `The message is too long (${text.length} of ${MAX_BODY_LENGTH} characters).`,
      );
    }

    const replyTo = integerValue(values, "reply", { min: 1, max: Number.MAX_SAFE_INTEGER });
    const { client } = await connect(context);
    const result = await client.post({
      body: text,
      kind: values.ask === true ? "human_request" : "message",
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    });

    if (context.json) {
      io.out(`${JSON.stringify(result)}\n`);
    } else {
      io.out(`Posted #${result.message.seq}\n`);
    }
    if (result.unknown_mentions.length > 0) {
      const names = result.unknown_mentions.map((h) => `@${h}`).join(", ");
      io.err(`Not delivered to ${names}: no such member on this board.\n`);
    }
    return EXIT.ok;
  },
};
