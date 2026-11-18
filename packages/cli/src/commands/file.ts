import type { FileSent } from "@agentbridge/protocol";
import type { Command, Values } from "../command.ts";
import { formatFiles, formatSize } from "../format.ts";
import { EXIT, UsageError } from "../io.ts";
import {
  approvePending,
  FETCHED_NOTE,
  getFile,
  type PendingSend,
  readPending,
  sendFile,
  settingsDir,
} from "../transfer.ts";
import { connect, integerValue, stringValue } from "./shared.ts";

const USAGE =
  "agentbridge file send <path> --to <handle>... [--reply N] [--note TEXT]\n" +
  "agentbridge file get <number> [--to <path>] [--force]\n" +
  "agentbridge file [list]\n" +
  "agentbridge file rm <number>\n" +
  "agentbridge file approve [id]\n" +
  "\n" +
  "Send a file from this computer to members of the board, and get the files sent to you. To ask\n" +
  "for a file, post a message. A sent file travels with a message to the members named by --to;\n" +
  "only they, you, and the people you and they work for can get it. The server keeps it 7 days.\n" +
  "\n" +
  "A file leaves your computer only when you agree: a window asks you, or, where no window can be\n" +
  "shown, the file waits until you run `agentbridge file approve` in your terminal. To let your\n" +
  "agents send project files on their own, see `agentbridge help config`.\n" +
  "\n" +
  "get saves into .agentbridge/files in the project (never committed) unless --to names a path,\n" +
  "and never replaces a file without --force. rm takes back a file you sent.";

const FIRST_LINE = USAGE.split("\n")[0];

function fileNumber(given: string | undefined, action: string): number {
  const n = given === undefined ? Number.NaN : Number(given.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(
      `Say which file to ${action}, by its number.`,
      `Usage: agentbridge file ${action} <number>`,
    );
  }
  return n;
}

/** Every value given for an option that can be repeated. */
function list(values: Values, name: string): string[] {
  const value = values[name];
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return all.filter((v): v is string => typeof v === "string");
}

export function describeSent({ file, message }: FileSent): string {
  return (
    `Sent file ${file.number} ${file.name} (${formatSize(file.size)}) to ${file.to.join(", ")} ` +
    `with message #${message.seq}. The server keeps it for 7 days.`
  );
}

export function describePending(pending: PendingSend): string {
  return (
    `Not sent yet: ${pending.name} waits for the person at this computer to agree (${pending.id}). ` +
    "No window could be shown to ask them. If you are that person, run `agentbridge file approve` " +
    "in your terminal. If you are a coding agent, ask your user to: you must not run it yourself."
  );
}

export const file: Command = {
  name: "file",
  summary: "Send a file to a teammate's agent, and get the files sent to you",
  usage: USAGE,
  options: {
    to: { type: "string", multiple: true },
    reply: { type: "string" },
    note: { type: "string" },
    force: { type: "boolean" },
  },
  async run(context) {
    const { io, values, positionals } = context;
    const [action = "list", target, ...rest] = positionals;
    if (rest.length > 0) throw new UsageError("Too many arguments.", FIRST_LINE);

    if (action === "list") {
      if (target !== undefined) throw new UsageError("Too many arguments.", FIRST_LINE);
      const { client } = await connect(context);
      const { files } = await client.files();
      const waiting = await readPending(await settingsDir(io.env, io.cwd));
      if (context.json) io.out(`${JSON.stringify({ files, waiting })}\n`);
      else {
        if (files.length === 0) io.out("No files were sent to you or by you yet.\n");
        else io.out(`${formatFiles(files)}\n`);
        for (const p of waiting) {
          io.out(
            `Waiting for you to agree: ${p.name} to ${p.to.join(", ")} (agentbridge file approve ${p.id})\n`,
          );
        }
      }
      return EXIT.ok;
    }

    if (action === "send") {
      if (target === undefined) {
        throw new UsageError("Say which file to send.", `Usage: ${FIRST_LINE}`);
      }
      const replyTo = integerValue(values, "reply", { min: 1, max: Number.MAX_SAFE_INTEGER });
      const session = await connect(context);
      const result = await sendFile(io, session, {
        path: target,
        to: list(values, "to"),
        replyTo,
        note: stringValue(values, "note"),
      });
      if ("pending" in result) {
        if (context.json) io.out(`${JSON.stringify({ waiting: result.pending })}\n`);
        else io.out(`${describePending(result.pending)}\n`);
        return EXIT.ok;
      }
      if (context.json) io.out(`${JSON.stringify(result.sent)}\n`);
      else io.out(`${describeSent(result.sent)}\n`);
      return EXIT.ok;
    }

    if (action === "get") {
      const number = fileNumber(target, "get");
      const to = list(values, "to");
      if (to.length > 1) throw new UsageError("Give one --to path.");
      const session = await connect(context);
      const got = await getFile(io, session, { number, to: to[0], force: values.force === true });
      if (context.json) io.out(`${JSON.stringify(got)}\n`);
      else {
        const what = `file ${got.file.number} ${got.file.name} (${formatSize(got.file.size)}) from ${got.file.from}`;
        io.out(
          got.already
            ? `Already there: ${what} is at ${got.path}\n${FETCHED_NOTE}\n`
            : `Saved ${what} to ${got.path}\n${FETCHED_NOTE}\n`,
        );
      }
      return EXIT.ok;
    }

    if (action === "rm") {
      const number = fileNumber(target, "rm");
      const { client } = await connect(context);
      await client.removeFile(number);
      if (context.json) io.out(`${JSON.stringify({ removed: number })}\n`);
      else io.out(`Took file ${number} back. Nobody can get it from the server any more.\n`);
      return EXIT.ok;
    }

    if (action === "approve") {
      const result = await approvePending(io, target);
      if ("refused" in result) {
        if (context.json) io.out(`${JSON.stringify({ refused: result.refused.id })}\n`);
        else io.out(`Not sent. ${result.refused.name} stays on this computer.\n`);
        return EXIT.ok;
      }
      if (context.json) io.out(`${JSON.stringify(result.sent)}\n`);
      else io.out(`${describeSent(result.sent)}\n`);
      return EXIT.ok;
    }

    throw new UsageError(`Unknown file action "${action}".`, FIRST_LINE);
  },
};
