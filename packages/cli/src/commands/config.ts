import type { Command } from "../command.ts";
import { findRepoConfig } from "../config.ts";
import { CliError, EXIT, UsageError } from "../io.ts";
import { oneLine } from "../printable.ts";
import { FILE_POLICIES, type FilePolicy, filePolicy, setFilePolicy } from "../settings.ts";
import { askPerson, settingsDir } from "../transfer.ts";

/** A board's name as it can be shown in a question: others chose it. */
const clean = (name: string) => oneLine(name).slice(0, 60);

const USAGE =
  "agentbridge config                     your settings for this board\n" +
  "agentbridge config files [ask | auto]  who decides that a file may leave this computer\n" +
  "\n" +
  "files ask (the default): you are asked every time one of your agents sends a file.\n" +
  "files auto: your agents send files of a project on this board on their own. You are still\n" +
  "asked about files outside the project folder, files git ignores or does not know, and files\n" +
  "named like secrets.\n" +
  "\n" +
  "Settings are yours alone: they are kept on this computer, per board, next to your keys.\n" +
  "Switching to auto has to be agreed by you, in a window or in your own terminal.";

const MEANING: Record<FilePolicy, string> = {
  ask: "you are asked every time one of your agents sends a file",
  auto:
    "your agents send files of a project on their own; you are asked about files outside " +
    "the project, hidden from git or named like secrets",
};

export const config: Command = {
  name: "config",
  summary: "Your own settings for this board, such as whether agents may send files unasked",
  usage: USAGE,
  options: {},
  async run(context) {
    const { io, positionals } = context;
    const [setting, value, ...rest] = positionals;
    if (rest.length > 0) throw new UsageError("Too many arguments.", USAGE.split("\n")[1]);
    if (setting !== undefined && setting !== "files") {
      throw new UsageError(`Unknown setting "${setting}".`, "There is one setting: files");
    }

    const repo = await findRepoConfig(io.cwd);
    if (!repo) {
      throw new CliError("This directory is not connected to a board.", {
        hint: "Settings are kept per board. Run this inside a project that joined one.",
      });
    }
    const dir = await settingsDir(io.env, io.cwd);
    const board = repo.config;
    const current = await filePolicy(dir, board.board_id);

    if (value === undefined) {
      if (context.json) io.out(`${JSON.stringify({ files: current })}\n`);
      else io.out(`files: ${current} (${MEANING[current]})\n`);
      return EXIT.ok;
    }

    if (!(FILE_POLICIES as readonly string[]).includes(value)) {
      throw new UsageError(`files is "ask" or "auto", not "${value}".`);
    }
    const wanted = value as FilePolicy;
    if (wanted === "auto" && current !== "auto") {
      // Less asking is for the person to grant, not for an agent to give itself.
      const answer = await askPerson(io, {
        title: "agentbridge: let agents send files?",
        text:
          `Let your agents on the board "${clean(board.board_name)}" send files from this ` +
          "computer without asking you each time? It holds for every project folder here that " +
          "is connected to this board.\n\n" +
          "You will still be asked about files outside the project folder, files git ignores " +
          "or does not know, and files named like secrets.\n\n" +
          "Switch back any time with: agentbridge config files ask",
        yes: "Allow",
        no: "Don't allow",
      });
      if (answer === "no") {
        throw new CliError("The person at this computer did not allow it. Nothing changed.");
      }
      if (answer === "unavailable") {
        throw new CliError("Only a person can allow this, in their own terminal.", {
          hint: "If you are a coding agent: ask your user to run `agentbridge config files auto`.",
        });
      }
    }
    await setFilePolicy(dir, board.board_id, wanted);
    if (context.json) io.out(`${JSON.stringify({ files: wanted })}\n`);
    else io.out(`files: ${wanted} (${MEANING[wanted]})\n`);
    return EXIT.ok;
  },
};
