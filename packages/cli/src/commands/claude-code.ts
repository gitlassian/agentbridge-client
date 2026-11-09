import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  hookStatus,
  type InstallReport,
  installHooks,
  repoRoot,
  SCOPES,
  type Scope,
  uninstallHooks,
  userHooksActive,
} from "../adapters/claude-code/install.ts";
import { HOOK_EVENTS, type HookEvent } from "../adapters/claude-code/settings.ts";
import type { Command } from "../command.ts";
import { CliError, EXIT, UsageError } from "../io.ts";
import { stringValue } from "./shared.ts";

function parseScope(value: string | undefined): Scope | undefined {
  if (value === undefined) return undefined;
  if (!(SCOPES as readonly string[]).includes(value)) {
    throw new UsageError(`Unknown scope "${value}".`, `Choose one of: ${SCOPES.join(", ")}.`);
  }
  return value as Scope;
}

/** True when `command` (its first word) can be found on PATH, so Claude Code can run it. */
export async function onPath(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const program = command.trim().split(/\s+/)[0] ?? "";
  if (program === "") return false;
  const candidates = program.includes("/")
    ? [program]
    : (env.PATH ?? "").split(delimiter).map((dir) => join(dir, program));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** The text shown after hooks were installed (also used by `agentbridge init`). */
export async function describeInstall(
  report: InstallReport,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const lines: string[] = [];
  if (report.alreadyInstalled) {
    lines.push(`Claude Code hooks are already installed in ${report.file}. Nothing changed.`);
    return lines.join("\n");
  }
  lines.push(
    report.dryRun
      ? `Would ${report.created ? "create" : "change"} ${report.file}`
      : `Claude Code hooks installed in ${report.file}`,
    `  hooks: ${[...report.events, ...(report.wake ? ["wake"] : [])].join(", ")}`,
    "  Your own settings and hooks are untouched; these are added next to them.",
  );
  if (!report.dryRun) {
    if (report.backup) lines.push(`  The file as it was is saved at ${report.backup}`);
    else lines.push("  The file did not exist before, so there was nothing to back up.");
    if (report.gitignoreUpdated)
      lines.push("  Added .claude/settings.local.json to .gitignore (it is personal).");
    lines.push(
      "",
      "Undo any time:  agentbridge claude-code uninstall",
      "  (add --restore-backup to put the file back exactly as it was before agentbridge)",
      "Claude Code picks the change up by itself; /hooks shows what is active. In a folder it has not",
      "seen before, Claude Code asks you to trust it before any hook runs.",
    );
  }
  if (!(await onPath(command, env))) {
    lines.push(
      "",
      `Warning: "${command.split(/\s+/)[0]}" is not on your PATH, so the hooks will do nothing yet.`,
      "Install the command globally, or pass --command with its full path.",
    );
  }
  return lines.join("\n");
}

export const claudeCode: Command = {
  name: "claude-code",
  summary: "Add agentbridge hooks to Claude Code (install, uninstall, status)",
  usage:
    "agentbridge claude-code install [--scope project|shared|user] [--no-stop] [--no-wake] [--dry-run] [--command CMD]\n" +
    "       agentbridge claude-code uninstall [--scope ...] [--restore-backup]\n" +
    "       agentbridge claude-code status\n" +
    "\n" +
    "Scopes: project = .claude/settings.local.json (personal, default); shared = .claude/settings.json\n" +
    "(committed, every teammate gets the hooks); user = ~/.claude/settings.json (all projects).\n" +
    "Hooks are added next to yours. The file is backed up first, outside the repository.\n" +
    "--no-stop: let the agent finish even with unread messages. --no-wake: do not wake an idle\n" +
    "agent when a message arrives (the background listener after each stop).",
  options: {
    scope: { type: "string" },
    command: { type: "string" },
    "no-stop": { type: "boolean" },
    "no-wake": { type: "boolean" },
    "dry-run": { type: "boolean" },
    "restore-backup": { type: "boolean" },
  },
  async run(context) {
    const { io, values, positionals } = context;
    const action = positionals[0];
    const scope = parseScope(stringValue(values, "scope"));

    if (action === "install") {
      const command = stringValue(values, "command") ?? "agentbridge";
      const events: readonly HookEvent[] =
        values["no-stop"] === true ? HOOK_EVENTS.filter((event) => event !== "Stop") : HOOK_EVENTS;
      const chosen = scope ?? "project";
      if (chosen !== "user" && (await userHooksActive(io.env))) {
        throw new CliError(
          "agentbridge's hooks are already installed for all your projects (agentbridge setup).",
          {
            hint: "Adding them here too would deliver every message twice. Nothing was changed.",
          },
        );
      }
      if (chosen !== "user" && !(await repoRoot(io.cwd)).connected) {
        io.err(
          "Note: this directory is not connected to a board yet (agentbridge init). The hooks do nothing until it is.\n",
        );
      }
      const report = await installHooks({
        env: io.env,
        cwd: io.cwd,
        scope: chosen,
        command,
        events,
        wake: values["no-wake"] !== true,
        dryRun: values["dry-run"] === true,
      });
      if (context.json) io.out(`${JSON.stringify(report)}\n`);
      else io.out(`${await describeInstall(report, command, io.env)}\n`);
      return EXIT.ok;
    }

    if (action === "uninstall") {
      const restore = values["restore-backup"] === true;
      const scopes = scope ? [scope] : SCOPES;
      const reports = [];
      for (const s of scopes) {
        try {
          reports.push(
            await uninstallHooks({ env: io.env, cwd: io.cwd, scope: s, restoreOriginal: restore }),
          );
        } catch (error) {
          // Looking through all scopes: one that agentbridge never touched is not an error.
          if (scope || !(error instanceof CliError)) throw error;
        }
      }
      if (context.json) {
        io.out(`${JSON.stringify(reports)}\n`);
        return EXIT.ok;
      }
      const touched = reports.filter((r) => r.removed > 0 || r.restored);
      if (touched.length === 0) {
        io.out("No agentbridge hooks found. Nothing to remove.\n");
        return EXIT.ok;
      }
      for (const r of touched) {
        if (r.restored) io.out(`Restored ${r.file} to how it was before agentbridge.\n`);
        else if (r.deleted)
          io.out(
            `Removed the hooks from ${r.file}. It was created by agentbridge and held nothing else, so it was deleted.\n`,
          );
        else
          io.out(
            `Removed ${r.removed} agentbridge hook${r.removed === 1 ? "" : "s"} from ${r.file}. Everything else is untouched.\n`,
          );
        if (r.backup) io.out(`  The file as it was before this change is saved at ${r.backup}\n`);
      }
      return EXIT.ok;
    }

    if (action === "status") {
      const entries = await hookStatus(io.env, io.cwd);
      if (context.json) {
        io.out(`${JSON.stringify(entries)}\n`);
        return EXIT.ok;
      }
      for (const e of entries) {
        const state =
          e.events.length > 0
            ? `installed (${[...e.events, ...(e.wake ? ["wake"] : [])].join(", ")})`
            : e.exists
              ? "not installed"
              : "no file";
        io.out(`${e.scope.padEnd(8)} ${state}\n         ${e.file}\n`);
        if (e.originalBackup) io.out(`         original saved at ${e.originalBackup}\n`);
      }
      return EXIT.ok;
    }

    throw new UsageError(
      action === undefined
        ? "Say what to do: install, uninstall or status."
        : `Unknown action "${action}".`,
      "Usage: agentbridge claude-code <install|uninstall|status>",
    );
  },
};
