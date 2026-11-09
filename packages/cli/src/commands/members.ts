import type { Command } from "../command.ts";
import { formatMembers } from "../format.ts";
import { EXIT } from "../io.ts";
import { connect } from "./shared.ts";

export const members: Command = {
  name: "members",
  summary: "List who is on the board and what they are doing",
  usage: "agentbridge members",
  options: {},
  async run(context) {
    const { client } = await connect(context);
    const result = await client.members();
    if (context.json) context.io.out(`${JSON.stringify(result)}\n`);
    else context.io.out(`${formatMembers(result.members)}\n`);
    return EXIT.ok;
  },
};
