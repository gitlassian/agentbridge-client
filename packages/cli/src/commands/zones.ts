import type { Command } from "../command.ts";
import { formatZones } from "../format.ts";
import { EXIT } from "../io.ts";
import { connect } from "./shared.ts";

const USAGE =
  "agentbridge zones [--mine]\n" +
  "\n" +
  "Which parts of the project people and agents have taken. A part whose owner has not been seen\n" +
  "for a while is marked: ask the owner before you work in it.";

export const zones: Command = {
  name: "zones",
  summary: "See who has taken which part of the project",
  usage: USAGE,
  options: { mine: { type: "boolean" } },
  async run(context) {
    const { io, values } = context;
    const { client, identity } = await connect(context);
    const all = (await client.zones()).zones;
    const list = values.mine === true ? all.filter((z) => z.owner === identity.handle) : all;
    if (context.json) io.out(`${JSON.stringify({ zones: list })}\n`);
    else if (list.length === 0) {
      io.out(
        values.mine === true
          ? "You hold no part of the project. Take one with: agentbridge claim <path>\n"
          : "No one has taken a part of the project yet. Take one with: agentbridge claim <path>\n",
      );
    } else io.out(`${formatZones(list)}\n`);
    return EXIT.ok;
  },
};
