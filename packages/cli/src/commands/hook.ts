import type { Command } from "../command.ts";
import { parseHarness } from "../hooks/harness.ts";
import { HOOK_NAMES, type HookName, runHook } from "../hooks/hook.ts";
import { runWake } from "../hooks/wake.ts";
import { UsageError } from "../io.ts";

const NAMES = [...HOOK_NAMES, "wake"] as const;

/**
 * Called by Claude Code or Codex, not by people. Exits 0 so it can never break the agent; only
 * the background `wake` hook of Claude Code exits 2, which tells it to wake the agent.
 */
export const hook: Command = {
  name: "hook",
  summary: "Run a hook (called by Claude Code or Codex, not by you)",
  usage: `agentbridge hook <${NAMES.join("|")}> [--tool claude|codex]   (reads the hook JSON on stdin)`,
  options: { tool: { type: "string" } },
  hidden: true,
  async run(context) {
    const name = context.positionals[0];
    const tool = context.values.tool;
    const harness = parseHarness(typeof tool === "string" ? tool : undefined);
    if (name === "wake") return runWake(context.io, harness);
    if (name === undefined || !(HOOK_NAMES as readonly string[]).includes(name)) {
      throw new UsageError(
        `Unknown hook "${name ?? ""}".`,
        `Usage: agentbridge hook <${NAMES.join("|")}>`,
      );
    }
    return runHook(context.io, name as HookName, harness);
  },
};
