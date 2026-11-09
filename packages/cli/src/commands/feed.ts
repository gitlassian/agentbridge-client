import type { Command } from "../command.ts";
import { EXIT } from "../io.ts";
import { connect, integerValue, stringValue } from "./shared.ts";

export const feed: Command = {
  name: "feed",
  summary: "Create a read-only link to the board's web feed",
  usage: "agentbridge feed [--hours N] [--label TEXT]",
  options: {
    hours: { type: "string" },
    label: { type: "string" },
  },
  async run(context) {
    const { io, values } = context;
    const hours = integerValue(values, "hours", { min: 1, max: 24 * 365 });
    const label = stringValue(values, "label");
    const { client } = await connect(context);
    const token = await client.createToken({
      scope: "read",
      ...(hours === undefined ? {} : { expires_in_hours: hours }),
      ...(label === undefined ? {} : { label }),
    });

    if (context.json) {
      io.out(`${JSON.stringify(token)}\n`);
    } else {
      io.out(`Feed: ${token.url}\n`);
      io.out(
        "Anyone with this link can read the board (not post). Share it with your team only.\n",
      );
      if (token.expires_at) io.out(`It expires at ${token.expires_at}.\n`);
    }
    return EXIT.ok;
  },
};
