import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_DOCUMENT_LENGTH } from "@agentbridge/protocol";
import { ApiError, checkDocumentName as checkName } from "../client.ts";
import type { Command } from "../command.ts";
import { formatDocuments } from "../format.ts";
import { CliError, EXIT, UsageError } from "../io.ts";
import { connect, integerValue } from "./shared.ts";

const USAGE =
  "agentbridge doc [list]                                   the board's shared documents\n" +
  "agentbridge doc read <name> [--version N]                print one\n" +
  "agentbridge doc write <name> [<file> | -] [--base N] [--pin | --unpin]\n" +
  "                                                         create or update one (text from the file,\n" +
  "                                                         or stdin with -)\n" +
  "agentbridge doc pin <name> / unpin <name>                make it the board context, or not\n" +
  "agentbridge doc rm <name>                                remove it\n" +
  "\n" +
  "Shared documents are plans, schemas, API contracts and decisions that every agent can read. Names\n" +
  'are path-like ("plan.md", "api/users.md"). A pinned document is the board context: every agent gets\n' +
  "it when a session starts. Changes appear in the log and the feed, never in anyone's inbox.\n" +
  "With --base N the write is refused if someone changed the document after version N.";

const needName = (action: string) =>
  new UsageError(`Say which document to ${action}.`, `Usage: agentbridge doc ${action} <name>`);

export const doc: Command = {
  name: "doc",
  summary: "Share plans, schemas and decisions with the whole board",
  usage: USAGE,
  options: {
    version: { type: "string" },
    base: { type: "string" },
    pin: { type: "boolean" },
    unpin: { type: "boolean" },
  },
  async run(context) {
    const { io, values, positionals } = context;
    const [action = "list", given, source, ...rest] = positionals;
    if (rest.length > 0) throw new UsageError("Too many arguments.", USAGE.split("\n")[0]);
    const name = given === undefined ? undefined : checkName(given);

    if (action === "list") {
      const { client } = await connect(context);
      const { documents } = await client.documents();
      if (context.json) io.out(`${JSON.stringify({ documents })}\n`);
      else if (documents.length === 0) {
        io.out("No shared documents yet. Add one with: agentbridge doc write plan.md plan.md\n");
      } else io.out(`${formatDocuments(documents)}\n`);
      return EXIT.ok;
    }

    if (action === "read") {
      if (!name) throw needName("read");
      const version = integerValue(values, "version", { min: 1, max: Number.MAX_SAFE_INTEGER });
      const { client } = await connect(context);
      const found = await client.document(name, version);
      if (found === null) {
        throw new CliError(`No document "${name}"${version ? ` version ${version}` : ""}.`, {
          hint: "List them with: agentbridge doc list",
        });
      }
      if (context.json) io.out(`${JSON.stringify({ document: found })}\n`);
      else {
        io.out(
          `${found.name}  version ${found.version}, by ${found.updated_by}${found.pinned ? ", pinned" : ""}\n\n` +
            `${found.body}${found.body.endsWith("\n") ? "" : "\n"}`,
        );
      }
      return EXIT.ok;
    }

    if (action === "write") {
      if (!name) throw needName("write");
      if (values.pin === true && values.unpin === true) {
        throw new UsageError("Use --pin or --unpin, not both.");
      }
      const body =
        source === undefined || source === "-"
          ? await io.readStdin()
          : await readFile(resolve(io.cwd, source), "utf8").catch(() => {
              throw new CliError(`Cannot read the file ${source}.`);
            });
      if (body.length > MAX_DOCUMENT_LENGTH) {
        throw new UsageError(
          `The document is too long (${body.length} of ${MAX_DOCUMENT_LENGTH} characters).`,
          "Split it into several documents.",
        );
      }
      const base = integerValue(values, "base", { min: 0, max: Number.MAX_SAFE_INTEGER });
      const pinned = values.pin === true ? true : values.unpin === true ? false : undefined;
      const { client } = await connect(context);
      const written = await writeOrExplain(client, name, {
        body,
        ...(base === undefined ? {} : { base_version: base }),
        ...(pinned === undefined ? {} : { pinned }),
      });
      if (context.json) io.out(`${JSON.stringify({ document: written })}\n`);
      else {
        io.out(
          `Saved ${written.name}, version ${written.version}${written.pinned ? " (pinned as board context)" : ""}. ` +
            "Teammates see the change in the log and the feed; read it with: " +
            `agentbridge doc read ${written.name}\n`,
        );
      }
      return EXIT.ok;
    }

    if (action === "pin" || action === "unpin") {
      if (!name) throw needName(action);
      const { client } = await connect(context);
      const found = await client.document(name);
      if (found === null) throw new CliError(`No document "${name}".`);
      const written = await writeOrExplain(client, name, {
        body: found.body,
        base_version: found.version,
        pinned: action === "pin",
      });
      if (context.json) io.out(`${JSON.stringify({ document: written })}\n`);
      else {
        io.out(
          action === "pin"
            ? `Pinned ${name}: every agent on the board gets it when a session starts.\n`
            : `Unpinned ${name}.\n`,
        );
      }
      return EXIT.ok;
    }

    if (action === "rm") {
      if (!name) throw needName("rm");
      const { client } = await connect(context);
      try {
        await client.deleteDocument(name);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          throw new CliError(`No document "${name}".`);
        }
        throw error;
      }
      if (context.json) io.out(`${JSON.stringify({ removed: name })}\n`);
      else io.out(`Removed ${name} and all its versions.\n`);
      return EXIT.ok;
    }

    throw new UsageError(`Unknown action "${action}".`, USAGE);
  },
};

async function writeOrExplain(
  client: Awaited<ReturnType<typeof connect>>["client"],
  name: string,
  body: Parameters<Awaited<ReturnType<typeof connect>>["client"]["writeDocument"]>[1],
) {
  try {
    return await client.writeDocument(name, body);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      throw new CliError(error.message, {
        hint: `Read the new version (agentbridge doc read ${name}), apply your change to it and write again.`,
      });
    }
    if (error instanceof ApiError && error.status === 422) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}
