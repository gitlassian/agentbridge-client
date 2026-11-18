import type { Command } from "../command.ts";
import { CliError, EXIT, UsageError } from "../io.ts";
import { connect } from "./shared.ts";

const USAGE =
  "agentbridge release [<name>...] [--all]\n" +
  "\n" +
  "Give up parts of the project you hold, by the name `agentbridge zones` shows. Without a name it\n" +
  "releases your only part; with --all, every part you hold.";

export const release: Command = {
  name: "release",
  summary: "Give a part of the project back",
  usage: USAGE,
  options: { all: { type: "boolean" } },
  async run(context) {
    const { io, values, positionals } = context;
    if (values.all === true && positionals.length > 0) {
      throw new UsageError("Use --all or names, not both.", USAGE.split("\n")[0]);
    }
    const { client, identity } = await connect(context);
    const mine = (await client.zones()).zones.filter((z) => z.owner === identity.handle);
    if (mine.length === 0) throw new CliError("You hold no part of the project.");

    let chosen = mine;
    if (values.all !== true) {
      if (positionals.length === 0) {
        if (mine.length > 1) {
          throw new UsageError(
            `You hold ${mine.length} parts: ${mine.map((z) => `"${z.name}"`).join(", ")}.`,
            "Say which to release, or use --all.",
          );
        }
      } else {
        const missing = positionals.filter((name) => !mine.some((z) => z.name === name));
        if (missing.length > 0) {
          throw new CliError(`You hold no part named ${missing.map((m) => `"${m}"`).join(", ")}.`, {
            hint: `Yours: ${mine.map((z) => `"${z.name}"`).join(", ")}`,
          });
        }
        chosen = mine.filter((z) => positionals.includes(z.name));
      }
    }
    for (const zone of chosen) await client.releaseZone(zone.id);
    if (context.json) io.out(`${JSON.stringify({ released: chosen.map((z) => z.name) })}\n`);
    else io.out(`Released ${chosen.map((z) => `"${z.name}"`).join(", ")}.\n`);
    return EXIT.ok;
  },
};
