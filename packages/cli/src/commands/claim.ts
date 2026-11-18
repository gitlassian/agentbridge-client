import type { Command } from "../command.ts";
import { describeOverlaps } from "../format.ts";
import { EXIT, UsageError } from "../io.ts";
import { connect, repoPaths, stringValue } from "./shared.ts";

const USAGE =
  "agentbridge claim <path>... [--name TEXT] [--note TEXT]\n" +
  "\n" +
  "Say which part of the project you are working on, before you start: a directory, a file or a\n" +
  'glob (web/checkout, src/api.ts, "web/**/*.css"). Paths are read from the folder you are in.\n' +
  "Teammates see the part on the board; if it meets theirs, they are told and so are you. Claiming\n" +
  "a name you already hold changes its paths. Give a part up with `agentbridge release`.";

export const claim: Command = {
  name: "claim",
  summary: "Take a part of the project so teammates and their agents stay out of it",
  usage: USAGE,
  options: { name: { type: "string" }, note: { type: "string" } },
  async run(context) {
    const { io, values, positionals } = context;
    if (positionals.length === 0) {
      throw new UsageError("Say which part of the project you take.", USAGE.split("\n")[0]);
    }
    const paths = await repoPaths(context, positionals);
    const name = stringValue(values, "name");
    const note = stringValue(values, "note");
    const { client } = await connect(context);
    const result = await client.claimZone({
      paths,
      ...(name === undefined ? {} : { name }),
      ...(note === undefined ? {} : { note }),
    });
    if (context.json) io.out(`${JSON.stringify(result)}\n`);
    else {
      io.out(
        `You hold "${result.zone.name}": ${result.zone.paths.join(", ")}. ` +
          "Teammates see it in the log and the feed.\n",
      );
      io.out(describeOverlaps(result.overlaps));
    }
    return EXIT.ok;
  },
};
