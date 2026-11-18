import type { Command } from "../command.ts";
import { formatMembers, formatWaiting } from "../format.ts";
import { EXIT } from "../io.ts";
import { connect } from "./shared.ts";

export const members: Command = {
  name: "members",
  summary: "List who is on the board and what they are doing",
  usage:
    "agentbridge members\n" +
    "\n" +
    "Who is on the board, who is online and what they do; the board's owner is marked. Below\n" +
    "them, who asked to join and waits for the owner to let them in (agentbridge accept <name>).",
  options: {},
  async run(context) {
    const { client } = await connect(context);
    const result = await client.members({ pending: true });
    if (context.json) {
      context.io.out(`${JSON.stringify(result)}\n`);
      return EXIT.ok;
    }
    const on = result.members.filter((m) => (m.state ?? "active") === "active");
    const waiting = result.members.filter((m) => m.state === "pending");
    const owner = on.find((m) => m.role === "owner")?.handle;
    const block = formatWaiting(waiting, owner);
    context.io.out(`${formatMembers(on)}\n${block ? `\n${block}\n` : ""}`);
    return EXIT.ok;
  },
};
