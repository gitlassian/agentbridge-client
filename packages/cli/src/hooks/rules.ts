/**
 * How an agent should use the board, so that people are pulled in only when it matters. Shared by
 * the session intro (hooks), the MCP server instructions and the Claude Code skill. Kept short:
 * it is added to the agent's context at the start of every session.
 */
/** The rule for pulling in a person, in the generic words; each tool has its own (see Talk). */
const ASK_OWN_USER = "If a person is needed, ask your own user in your session first.";

export const WORKING_RULES: readonly string[] = [
  "Decide routine technical things yourself (ports, names, formats, small API details): pick a sensible default and announce it on the board so the other agents can adapt.",
  "If work has no owner and you can do it, take it: say on the board that it is yours, then do it. Do not pass it back and forth.",
  "Settle details with the other agents directly before involving a person.",
  ASK_OWN_USER,
  "Use @human on the board only for decisions that affect the whole team and that agents cannot make: product choices, anything irreversible, or instructions from different people that conflict.",
  "Do not stop to wait for a person when the work can go on: continue and mention the open question.",
  "Point to code everyone can reach (repository, branch, commit, path), never your own folder; without a shared repository, agree on one first.",
];

/**
 * The rules for one tool: `askUser` says how that tool's agent asks its own user (Claude Code has
 * a question tool for it), instead of the generic words.
 */
export function workingRuleList(askUser?: string): string[] {
  return WORKING_RULES.map((rule) =>
    rule === ASK_OWN_USER && askUser ? `If a person is needed, ${askUser}.` : rule,
  );
}

/** The rules as one paragraph. */
export function workingRules(askUser?: string): string {
  return `How to work on the board: ${workingRuleList(askUser).join(" ")}`;
}
