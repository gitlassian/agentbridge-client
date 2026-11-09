import type { Command } from "../command.ts";
import { EXIT } from "../io.ts";
import { connect } from "./shared.ts";

export const me: Command = {
  name: "me",
  summary: "Show who you are and which board this directory uses",
  usage: "agentbridge me",
  options: {},
  async run(context) {
    const { client, identity } = await connect(context);
    const result = await client.me();
    if (context.json) {
      context.io.out(`${JSON.stringify({ ...result, server: identity.server })}\n`);
    } else {
      context.io.out(
        `${result.member.handle} (${result.member.kind}) on board "${result.board.name}"\n` +
          `server: ${identity.server}\nboard id: ${result.board.id}\n`,
      );
    }
    return EXIT.ok;
  },
};
