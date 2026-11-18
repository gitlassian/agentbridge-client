import type { Command } from "../command.ts";
import { formatDay, inviteMessage } from "../format.ts";
import { EXIT, UsageError } from "../io.ts";
import { connect, integerValue, requirePerson, stringValue } from "./shared.ts";

export const invite: Command = {
  name: "invite",
  summary: "Create an invite link for a teammate",
  usage:
    "agentbridge invite [--hours N] [--label TEXT] [--once | --uses N] [--open]\n" +
    "\n" +
    "An invite works for 7 days (--hours to change it) and lets in as many people as come with it\n" +
    "(--once for one person, --uses N for N). Everyone who comes through it waits until the\n" +
    "board's owner lets them in (agentbridge accept <name>). --open makes an invite that needs\n" +
    "no approval, for your own team; only the owner can make one, in their own terminal.\n" +
    "agentbridge links lists the links, agentbridge revoke <id> stops one.",
  options: {
    hours: { type: "string" },
    label: { type: "string" },
    once: { type: "boolean" },
    uses: { type: "string" },
    open: { type: "boolean" },
  },
  async run(context) {
    const { io, values } = context;
    const hours = integerValue(values, "hours", { min: 1, max: 24 * 365 });
    const label = stringValue(values, "label");
    const uses = integerValue(values, "uses", { min: 1, max: 1000 });
    if (values.once === true && uses !== undefined) {
      throw new UsageError("Use --once or --uses N, not both.");
    }
    const maxUses = values.once === true ? 1 : uses;
    const open = values.open === true;
    if (open) requirePerson(io, "agentbridge invite --open");
    const { client, identity } = await connect(context);
    const token = await client.createToken({
      scope: "join",
      ...(hours === undefined ? {} : { expires_in_hours: hours }),
      ...(label === undefined ? {} : { label }),
      ...(maxUses === undefined ? {} : { max_uses: maxUses }),
      ...(open ? { open: true } : {}),
    });

    const message = inviteMessage(identity.boardName ?? "team", token.url);
    if (context.json) {
      io.out(`${JSON.stringify({ ...token, invite_message: message })}\n`);
      return EXIT.ok;
    }
    io.out(`Invite link: ${token.url}\n`);
    io.out(`\nSend this to a teammate; they paste it into their coding agent:\n  ${message}\n`);
    io.out(`(Without an agent: agentbridge init --join ${token.url})\n`);
    const limits: string[] = [];
    if (token.expires_at) limits.push(`works until ${formatDay(token.expires_at)}`);
    if (token.max_uses) {
      limits.push(token.max_uses === 1 ? "lets in one person" : `lets in ${token.max_uses} people`);
    }
    if (limits.length > 0) io.out(`\nIt ${limits.join(" and ")}.`);
    io.out(
      token.requires_approval
        ? " Each newcomer waits until the board's owner lets them in: agentbridge accept <name>.\n"
        : " Whoever comes with it is on the board at once.\n",
    );
    return EXIT.ok;
  },
};
