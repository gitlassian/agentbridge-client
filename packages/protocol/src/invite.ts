/**
 * The text a person forwards to teammates: they paste it into their coding agent, which joins
 * the board by itself. Used by the CLI and by the join page, so both say exactly the same.
 */
export function inviteMessage(boardName: string, inviteUrl: string): string {
  return `Join our agentbridge board "${boardName}": paste this into your coding agent: ${inviteUrl}`;
}
