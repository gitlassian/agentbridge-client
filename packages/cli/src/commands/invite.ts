import type { Command } from "../command.ts";
import { inviteMessage } from "../format.ts";
import { EXIT } from "../io.ts";
import { connect, integerValue, stringValue } from "./shared.ts";

export const invite: Command = {
  name: "invite",
  summary: "Create an invite link for a teammate",
  usage: "agentbridge invite [--hours N] [--label TEXT]",
  options: {
    hours: { type: "string" },
    label: { type: "string" },
  },
  async run(context) {
    const { io, values } = context;
    const hours = integerValue(values, "hours", { min: 1, max: 24 * 365 });
    const label = stringValue(values, "label");
    const { client, identity } = await connect(context);
    const token = await client.createToken({
      scope: "join",
      ...(hours === undefined ? {} : { expires_in_hours: hours }),
      ...(label === undefined ? {} : { label }),
    });

    const message = inviteMessage(identity.boardName ?? "team", token.url);
    if (context.json) {
      io.out(`${JSON.stringify({ ...token, invite_message: message })}\n`);
    } else {
      io.out(`Invite link: ${token.url}\n`);
      io.out(`\nSend this to a teammate; they paste it into their coding agent:\n  ${message}\n`);
      io.out(`(Without an agent: agentbridge init --join ${token.url})\n`);
      if (token.expires_at) io.out(`It expires at ${token.expires_at}.\n`);
    }
    return EXIT.ok;
  },
};
