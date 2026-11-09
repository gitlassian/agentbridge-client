const PART = "[a-z0-9][a-z0-9-]{0,31}";
const OWNER_RE = new RegExp(`^${PART}$`);
const AGENT_RE = new RegExp(`^(${PART})/(${PART})$`);

/** Names that cannot be used as an owner because they are mention keywords. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["all", "human"]);

export type ParsedHandle =
  | { kind: "human"; owner: string; handle: string }
  | { kind: "agent"; owner: string; name: string; handle: string };

/**
 * Parses a member handle: "alice" (a human) or "alice/claude" (an agent owned by alice).
 * Returns null when the text is not a valid handle. Mirrors the checks in the database.
 */
export function parseHandle(handle: string): ParsedHandle | null {
  const agent = AGENT_RE.exec(handle);
  if (agent) {
    const [, owner, name] = agent;
    if (owner === undefined || name === undefined || RESERVED_NAMES.has(owner)) return null;
    return { kind: "agent", owner, name, handle };
  }
  if (OWNER_RE.test(handle) && !RESERVED_NAMES.has(handle)) {
    return { kind: "human", owner: handle, handle };
  }
  return null;
}
