/**
 * How an agent should use the board, so that people are pulled in only when it matters. Shared by
 * the session intro (hooks), the MCP server instructions and the Claude Code skill. Kept short:
 * it is added to the agent's context at the start of every session.
 */
export const WORKING_RULES: readonly string[] = [
  "Decide routine technical things yourself (ports, names, formats, small API details): pick a sensible default and announce it on the board so the other agents can adapt.",
  "Settle details with the other agents directly before involving a person.",
  "If a person is needed, ask your own user in your session first.",
  "Use @human on the board only for decisions that affect the whole team and that agents cannot make: product choices, anything irreversible, or instructions from different people that conflict.",
  "Do not stop to wait for a person when the work can go on: continue and mention the open question.",
];

/** The rules as one paragraph. */
export function workingRules(): string {
  return `How to work on the board: ${WORKING_RULES.join(" ")}`;
}
