import type { Command } from "../command.ts";
import { forgetBoard } from "../config.ts";
import { formatLinks, formatSecurityEvents } from "../format.ts";
import { EXIT, UsageError } from "../io.ts";
import { connect, integerValue, requirePerson } from "./shared.ts";

const PERSON = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,31}(\/[a-z0-9][a-z0-9-]{0,31})?$/;

function nameArg(positionals: string[], usage: string, pattern = PERSON): string {
  const name = positionals[0]?.replace(/^@/, "");
  if (!name) throw new UsageError("Say whom.", `Usage: ${usage}`);
  if (!pattern.test(name)) throw new UsageError(`"${name}" is not a name on a board.`);
  return name;
}

export const accept: Command = {
  name: "accept",
  summary: "Let someone who asked to join onto the board (the board's owner)",
  usage:
    "agentbridge accept <name>\n" +
    "\n" +
    "Lets a person who joined through an invite that needs approval onto the board, with their\n" +
    "agents. `agentbridge members` lists who is waiting. Only the board's owner can, in their own\n" +
    "terminal.",
  options: {},
  async run(context) {
    const name = nameArg(context.positionals, "agentbridge accept <name>");
    requirePerson(context.io, `agentbridge accept ${name}`);
    const { client } = await connect(context);
    await client.accept(name);
    if (context.json) context.io.out(`${JSON.stringify({ accepted: name })}\n`);
    else context.io.out(`${name} is on the board now, with their agents. They have been told.\n`);
    return EXIT.ok;
  },
};

export const decline: Command = {
  name: "decline",
  summary: "Turn down someone who asked to join (the board's owner)",
  usage: "agentbridge decline <name>",
  options: {},
  async run(context) {
    const name = nameArg(context.positionals, "agentbridge decline <name>");
    requirePerson(context.io, `agentbridge decline ${name}`);
    const { client } = await connect(context);
    await client.decline(name);
    if (context.json) context.io.out(`${JSON.stringify({ declined: name })}\n`);
    else context.io.out(`Turned down ${name}. Their keys no longer work on this board.\n`);
    return EXIT.ok;
  },
};

export const remove: Command = {
  name: "remove",
  summary: "Take someone off the board, or one of your agents",
  usage:
    "agentbridge remove <name>        a person, with all their agents (the board's owner)\n" +
    "agentbridge remove <you>/<agent> one of your own agents\n" +
    "\n" +
    "Their keys and the links they made stop working at once, their tasks and parts of the\n" +
    "project are freed, and their messages stay in the history. Only a person can, in their own\n" +
    "terminal. An agent of yours can come back: agentbridge init --agent <agent>.",
  options: {},
  async run(context) {
    const handle = nameArg(context.positionals, "agentbridge remove <name>", HANDLE);
    requirePerson(context.io, `agentbridge remove ${handle}`);
    const { client } = await connect(context);
    await client.removeMember(handle);
    if (context.json) context.io.out(`${JSON.stringify({ removed: handle })}\n`);
    else {
      const who = handle.includes("/") ? handle : `${handle} and their agents`;
      context.io.out(`Took ${who} off the board. Their keys no longer work.\n`);
    }
    return EXIT.ok;
  },
};

export const leave: Command = {
  name: "leave",
  summary: "Leave the board, with all your agents",
  usage:
    "agentbridge leave\n" +
    "\n" +
    "Takes you and your agents off the board. Your messages stay. The owner hands the board over\n" +
    "first (agentbridge owner <name>). The keys for the board on this machine are deleted. To\n" +
    "come back you need an invite, and you join under a new name: names on a board are never\n" +
    "given out again.",
  options: {},
  async run(context) {
    requirePerson(context.io, "agentbridge leave");
    const { client, identity } = await connect(context);
    await client.leave();
    if (identity.boardId) await forgetBoard(context.io.env, identity.boardId);
    if (context.json) context.io.out(`${JSON.stringify({ left: identity.boardName ?? null })}\n`);
    else context.io.out(`You left the board "${identity.boardName ?? ""}", with your agents.\n`);
    return EXIT.ok;
  },
};

export const owner: Command = {
  name: "owner",
  summary: "Show who owns the board, or hand it to another person",
  usage:
    "agentbridge owner           who owns the board\n" +
    "agentbridge owner <name>    hand the board to another person on it (the owner)",
  options: {},
  async run(context) {
    const { io, positionals } = context;
    if (positionals.length === 0) {
      const { client } = await connect(context);
      const me = await client.me();
      if (context.json) io.out(`${JSON.stringify({ owner: me.board_owner ?? null })}\n`);
      else io.out(`${me.board_owner ?? "Nobody owns this board."}\n`);
      return EXIT.ok;
    }
    const name = nameArg(positionals, "agentbridge owner <name>");
    requirePerson(io, `agentbridge owner ${name}`);
    const { client } = await connect(context);
    await client.handOver(name);
    if (context.json) io.out(`${JSON.stringify({ owner: name })}\n`);
    else io.out(`${name} owns the board now.\n`);
    return EXIT.ok;
  },
};

export const links: Command = {
  name: "links",
  summary: "List the board's invite and feed links",
  usage:
    "agentbridge links [--all]\n" +
    "\n" +
    "The links that still work: invites and read-only feed links, who made each, how long it\n" +
    "works and how many people it brought in. The owner sees every link, anyone else their own.\n" +
    "--all also lists the links that ended. Stop one with: agentbridge revoke <id>",
  options: { all: { type: "boolean" } },
  async run(context) {
    const { client } = await connect(context);
    const { tokens } = await client.tokens();
    const shown = context.values.all === true ? tokens : tokens.filter((t) => t.active);
    if (context.json) context.io.out(`${JSON.stringify({ tokens: shown })}\n`);
    else if (shown.length === 0) {
      context.io.out(
        context.values.all === true
          ? "No links.\n"
          : "No link works right now. Make one with: agentbridge invite\n",
      );
    } else context.io.out(`${formatLinks(shown)}\n`);
    return EXIT.ok;
  },
};

export const revoke: Command = {
  name: "revoke",
  summary: "Stop an invite or feed link",
  usage:
    "agentbridge revoke <id>\n" +
    "\n" +
    "The link stops at once: an invite lets nobody else in, and a web panel open with a feed\n" +
    "link stops getting the board. `agentbridge links` shows the ids. Only a person can, in\n" +
    "their own terminal.",
  options: {},
  async run(context) {
    const id = context.positionals[0];
    if (!id || !/^tok_[A-Za-z0-9]+$/.test(id)) {
      throw new UsageError(
        "Say which link, by its id (tok_...).",
        "Usage: agentbridge revoke <id>",
      );
    }
    requirePerson(context.io, `agentbridge revoke ${id}`);
    const { client } = await connect(context);
    await client.revokeToken(id);
    if (context.json) context.io.out(`${JSON.stringify({ revoked: id })}\n`);
    else context.io.out(`Stopped ${id}.\n`);
    return EXIT.ok;
  },
};

export const audit: Command = {
  name: "audit",
  summary: "The board's security log (the board's owner)",
  usage:
    "agentbridge audit [-n COUNT]\n" +
    "\n" +
    "Newest first: who joined or asked to, who was let in, turned down or taken off, which links\n" +
    "were made and stopped, and hand-overs of the board.",
  options: { n: { type: "string", short: "n" } },
  async run(context) {
    const limit = integerValue(context.values, "n", { min: 1, max: 200 });
    const { client } = await connect(context);
    const { events } = await client.audit(limit);
    if (context.json) context.io.out(`${JSON.stringify({ events })}\n`);
    else if (events.length === 0) context.io.out("Nothing in the log yet.\n");
    else context.io.out(`${formatSecurityEvents(events)}\n`);
    return EXIT.ok;
  },
};
