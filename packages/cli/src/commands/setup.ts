import { stat } from "node:fs/promises";
import {
  codexHome,
  codexHookStatus,
  hookStatus,
  type InstallReport,
  installHooks,
  uninstallHooks,
} from "../adapters/claude-code/install.ts";
import { HOOK_EVENTS } from "../adapters/claude-code/settings.ts";
import {
  installSkill,
  removeSkill,
  type SkillState,
  skillPath,
  skillState,
} from "../adapters/claude-code/skill.ts";
import {
  codexConfigFile,
  codexMcpState,
  installCodexMcp,
  type McpState,
  removeCodexMcp,
} from "../adapters/codex/config.ts";
import type { Command } from "../command.ts";
import type { Harness } from "../hooks/harness.ts";
import { EXIT } from "../io.ts";
import { onPath } from "./claude-code.ts";
import { stringValue } from "./shared.ts";

const SKILL_NOTE: Record<SkillState, string> = {
  missing: "installed",
  outdated: "updated",
  current: "already up to date",
  foreign: "skipped: a skill named agentbridge that agentbridge did not write is already there",
};

const MCP_NOTE: Record<McpState, string> = {
  missing: "added",
  outdated: "updated",
  current: "already there",
  foreign: "skipped: an MCP server named agentbridge that agentbridge did not add is already there",
};

const SKILL_STATUS: Record<SkillState, string> = {
  current: "installed",
  outdated: "outdated (run agentbridge setup)",
  foreign: "a different skill named agentbridge is there",
  missing: "not installed",
};

const MCP_STATUS: Record<McpState, string> = {
  current: "added",
  outdated: "outdated (run agentbridge setup)",
  foreign: "a different server named agentbridge is configured",
  missing: "not added",
};

/** Codex is on this machine: its folder exists or the command is on PATH. */
async function codexPresent(env: NodeJS.ProcessEnv): Promise<boolean> {
  const folder = await stat(codexHome(env)).then(
    (s) => s.isDirectory(),
    () => false,
  );
  return folder || (await onPath("codex", env));
}

function hookList(events: readonly string[], wake: boolean): string {
  return [...events, ...(wake ? ["wake"] : [])].join(", ");
}

function hooksText(tool: string, hooks: InstallReport, dryRun: boolean): string[] {
  if (hooks.alreadyInstalled) return [`  Hooks: already installed in ${hooks.file}`];
  const lines = [
    `  Hooks: ${dryRun ? "would be installed" : "installed"} in ${hooks.file}`,
    `    ${hookList(hooks.events, hooks.wake)}; your own settings and hooks are untouched.`,
  ];
  if (hooks.backup) lines.push(`    The file as it was is saved at ${hooks.backup}`);
  if (tool === "Codex" && !dryRun) {
    lines.push(
      "    Codex runs new hooks only after you trust them: open Codex, type /hooks and trust the",
      "    agentbridge ones (once; again after an update changes them).",
    );
  }
  return lines;
}

/**
 * One-time setup per machine. For Claude Code: hooks for every project (~/.claude/settings.json)
 * and a skill that teaches the agent how to join and use a board. For Codex, when it is
 * installed: the agentbridge MCP server in ~/.codex/config.toml, the same hooks in
 * ~/.codex/hooks.json and the skill in ~/.agents/skills. The hooks do nothing in a directory that
 * is not connected to a board, so after this a person only has to hand an invite link to their
 * agent.
 */
export const setup: Command = {
  name: "setup",
  summary: "One-time setup: hooks and the agentbridge skill for Claude Code and Codex",
  usage:
    "agentbridge setup [--no-codex] [--no-wake] [--no-skill] [--dry-run] [--command CMD]\n" +
    "       agentbridge setup --status\n" +
    "       agentbridge setup --remove\n" +
    "\n" +
    "Claude Code: adds agentbridge's hooks to ~/.claude/settings.json (next to yours, file backed\n" +
    "up first) and the skill ~/.claude/skills/agentbridge.\n" +
    "Codex (when installed): adds the agentbridge MCP server to ~/.codex/config.toml, the hooks to\n" +
    "~/.codex/hooks.json and the skill ~/.agents/skills/agentbridge. --no-codex leaves Codex alone.\n" +
    "The hooks stay silent in directories that are not connected to a board. After this, paste an\n" +
    "invite link into your agent and it joins by itself.",
  options: {
    status: { type: "boolean" },
    remove: { type: "boolean" },
    "no-codex": { type: "boolean" },
    "no-wake": { type: "boolean" },
    "no-skill": { type: "boolean" },
    "dry-run": { type: "boolean" },
    command: { type: "string" },
  },
  async run(context) {
    const { io, values } = context;
    const command = stringValue(values, "command") ?? "agentbridge";

    if (values.status === true) {
      const user = (await hookStatus(io.env, io.cwd)).find((entry) => entry.scope === "user");
      const skill = await skillState(io.env);
      const codexHooks = await codexHookStatus(io.env);
      const codex = {
        present: await codexPresent(io.env),
        mcp: await codexMcpState(io.env, command),
        mcp_file: codexConfigFile(io.env),
        hooks: codexHooks.events,
        wake: codexHooks.wake,
        hooks_file: codexHooks.file,
        skill: await skillState(io.env, "codex"),
        skill_file: skillPath(io.env, "codex"),
      };
      const report = {
        hooks: user?.events ?? [],
        wake: user?.wake ?? false,
        hooks_file: user?.file,
        skill,
        skill_file: skillPath(io.env),
        codex,
      };
      if (context.json) {
        io.out(`${JSON.stringify(report)}\n`);
        return EXIT.ok;
      }
      const claudeHooks = hookList(report.hooks, report.wake);
      const lines = [
        "Claude Code",
        `  Hooks: ${claudeHooks ? `installed (${claudeHooks})` : "not installed"}`,
        `    ${report.hooks_file}`,
        `  Skill: ${SKILL_STATUS[skill]}`,
        `    ${report.skill_file}`,
      ];
      if (codex.present || codex.mcp !== "missing" || codex.hooks.length > 0) {
        const hooks = hookList(codex.hooks, codex.wake);
        lines.push(
          "Codex",
          `  MCP server: ${MCP_STATUS[codex.mcp]}`,
          `    ${codex.mcp_file}`,
          `  Hooks: ${hooks ? `installed (${hooks})` : "not installed"}`,
          `    ${codex.hooks_file}`,
          `  Skill: ${SKILL_STATUS[codex.skill]}`,
          `    ${codex.skill_file}`,
        );
      } else {
        lines.push("Codex: not found on this machine");
      }
      io.out(`${lines.join("\n")}\n`);
      return EXIT.ok;
    }

    if (values.remove === true) {
      const hooks = await uninstallHooks({
        env: io.env,
        cwd: io.cwd,
        scope: "user",
        restoreOriginal: false,
      });
      const skillRemoved = await removeSkill(io.env);
      const codexHooks = await uninstallHooks({
        env: io.env,
        cwd: io.cwd,
        scope: "user",
        restoreOriginal: false,
        harness: "codex",
      });
      const mcp = await removeCodexMcp(io.env);
      const codexSkillRemoved = await removeSkill(io.env, "codex");
      if (context.json) {
        io.out(
          `${JSON.stringify({
            hooks_removed: hooks.removed,
            skill_removed: skillRemoved,
            codex: {
              hooks_removed: codexHooks.removed,
              mcp_removed: mcp.removed,
              skill_removed: codexSkillRemoved,
            },
          })}\n`,
        );
        return EXIT.ok;
      }
      const lines = [
        hooks.removed > 0
          ? `Removed ${hooks.removed} agentbridge hooks from ${hooks.file}`
          : "No agentbridge hooks were installed for all projects in Claude Code.",
        skillRemoved
          ? `Removed the skill ${skillPath(io.env)}`
          : "No agentbridge skill for Claude Code to remove.",
      ];
      if (hooks.backup) lines.push(`  The settings file as it was is saved at ${hooks.backup}`);
      if (codexHooks.removed > 0) {
        lines.push(`Removed ${codexHooks.removed} agentbridge hooks from ${codexHooks.file}`);
        if (codexHooks.backup) lines.push(`  The file as it was is saved at ${codexHooks.backup}`);
      }
      if (mcp.removed) {
        lines.push(`Removed the agentbridge MCP server from ${mcp.file}`);
        if (mcp.backup) lines.push(`  The file as it was is saved at ${mcp.backup}`);
      }
      if (codexSkillRemoved) lines.push(`Removed the skill ${skillPath(io.env, "codex")}`);
      io.out(`${lines.join("\n")}\n`);
      return EXIT.ok;
    }

    const dryRun = values["dry-run"] === true;
    const wake = values["no-wake"] !== true;
    const withSkill = values["no-skill"] !== true;
    const install = (harness: Harness) =>
      installHooks({
        env: io.env,
        cwd: io.cwd,
        scope: "user",
        command,
        events: HOOK_EVENTS,
        wake,
        dryRun,
        harness,
      });

    const hooks = await install("claude");
    const skill = withSkill ? await installSkill(io.env, { dryRun }) : null;

    const codexWanted = values["no-codex"] !== true && (await codexPresent(io.env));
    const codex = codexWanted
      ? {
          mcp: await installCodexMcp(io.env, { command, dryRun }),
          hooks: await install("codex"),
          skill: withSkill ? await installSkill(io.env, { dryRun, harness: "codex" }) : null,
        }
      : null;
    const reachable = await onPath(command, io.env);

    if (context.json) {
      io.out(
        `${JSON.stringify({
          hooks,
          skill,
          skill_file: skillPath(io.env),
          codex:
            codex === null
              ? null
              : { ...codex, skill_file: withSkill ? skillPath(io.env, "codex") : null },
          on_path: reachable,
        })}\n`,
      );
      return EXIT.ok;
    }

    const skillLine = (state: SkillState) =>
      `  Skill: ${dryRun && state !== "current" ? "would be written" : SKILL_NOTE[state]}`;
    const lines: string[] = ["Claude Code", ...hooksText("Claude Code", hooks, dryRun)];
    if (skill !== null) lines.push(skillLine(skill), `    ${skillPath(io.env)}`);

    if (codex !== null) {
      const { mcp } = codex;
      lines.push(
        "Codex",
        `  MCP server: ${dryRun && mcp.state !== "current" && mcp.state !== "foreign" ? "would be added" : MCP_NOTE[mcp.state]} in ${mcp.file}`,
      );
      if (mcp.backup) lines.push(`    The file as it was is saved at ${mcp.backup}`);
      lines.push(...hooksText("Codex", codex.hooks, dryRun));
      if (codex.skill !== null) {
        lines.push(skillLine(codex.skill), `    ${skillPath(io.env, "codex")}`);
      }
    }

    const agents = codex === null ? "Claude Code" : "Claude Code or Codex";
    lines.push(
      "",
      `Done. In any project, paste an agentbridge invite link into ${agents} and it joins the board`,
      'by itself, or ask it to "create an agentbridge board for this project".',
      "Undo: agentbridge setup --remove",
    );
    if (!reachable) {
      lines.push(
        "",
        `Warning: "${command.split(/\s+/)[0]}" is not on your PATH, so the hooks will do nothing yet.`,
        "Install the command globally, or pass --command with its full path.",
      );
    }
    io.out(`${lines.join("\n")}\n`);
    return EXIT.ok;
  },
};
