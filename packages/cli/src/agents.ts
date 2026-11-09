/**
 * Which of a person's agents a command acts as.
 *
 * One person can have several agents on a board (Claude Code in one terminal, Codex in another).
 * Each stored agent remembers the coding tool it was created from, so a command run by Codex
 * acts as the Codex agent without anyone naming it.
 */

/** Coding tools we can recognise. The agent name defaults to the tool's name. */
export const KNOWN_TOOLS = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "agy",
  "grok",
  "muse",
  "hermes",
] as const;

/** Which coding agent is running this command, from the variables agents set for their tools. */
export function detectAgent(env: NodeJS.ProcessEnv): string | undefined {
  const marker = (env.AI_AGENT ?? "").toLowerCase();
  if (env.CLAUDECODE === "1" || marker.startsWith("claude")) return "claude";
  if (marker.includes("codex") || Object.keys(env).some((key) => key.startsWith("CODEX_"))) {
    return "codex";
  }
  if (marker.includes("cursor") || env.CURSOR_AGENT !== undefined) return "cursor";
  if (marker.includes("gemini")) return "gemini";
  return undefined;
}

/** The tool an agent most likely belongs to, judged by its name (for files without `tool`). */
export function toolFromName(name: string): string | undefined {
  return (KNOWN_TOOLS as readonly string[]).includes(name) ? name : undefined;
}

export interface StoredAgent {
  tool?: string | undefined;
}

export type AgentChoice =
  | { kind: "found"; name: string }
  | { kind: "register"; name: string; tool: string | undefined }
  | { kind: "none" }
  | { kind: "ambiguous"; names: string[] };

/**
 * Picks the agent to act as:
 * 1. the name asked for (`--agent`, AGENTBRIDGE_AGENT), registering it when it is new;
 * 2. the agent created from the coding tool that runs the command, registering one when the
 *    person has none for that tool yet;
 * 3. the only agent, when nothing identifies the tool;
 * otherwise the caller has to ask which one.
 */
export function chooseAgent(
  agents: Record<string, StoredAgent>,
  want: { name?: string | undefined; tool?: string | undefined },
): AgentChoice {
  const names = Object.keys(agents).sort();
  if (want.name !== undefined) {
    return agents[want.name]
      ? { kind: "found", name: want.name }
      : { kind: "register", name: want.name, tool: want.tool };
  }
  if (want.tool !== undefined) {
    const match =
      names.find((name) => agents[name]?.tool === want.tool) ??
      (agents[want.tool] ? want.tool : undefined);
    return match
      ? { kind: "found", name: match }
      : { kind: "register", name: want.tool, tool: want.tool };
  }
  if (names.length === 1) return { kind: "found", name: names[0] as string };
  if (names.length === 0) return { kind: "none" };
  return { kind: "ambiguous", names };
}
