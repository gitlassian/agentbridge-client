import type {
  DocumentInfo,
  FileInfo,
  FileRef,
  InboxMessage,
  MemberOut,
  Message,
  SecurityEvent,
  Task,
  TokenOut,
  Zone,
  ZoneOverlap,
} from "@agentbridge/protocol";
import { bare, oneLine } from "./printable.ts";

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "today 14:02", or "2026-11-09 14:02" for another day (local time). */
export function formatDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day(date) === day(now) ? "today" : day(date)} ${formatTime(iso)}`;
}

/** Who a message is addressed to, as "@bob/codex, @all". */
function targets(message: Message): string[] {
  const list = message.mentions.map((handle) => `@${handle}`);
  if (message.mention_all) list.push("@all");
  if (message.mention_humans) list.push("@human");
  return list;
}

/**
 *   #12 14:02  alice/claude → @bob/codex  ↩ #10
 *       the message text, indented
 */
/**
 * Who a message has reached, for `log` and `read`: "seen by bob/codex; not yet by bob". Empty for
 * a message addressed to nobody. A message counts as seen once it was added to the addressee's
 * context (by a hook or a tool) or they read their inbox.
 */
export function formatReceipts(message: Pick<Message, "recipients" | "seen_by">): string {
  if (message.recipients.length === 0) return "";
  const seen = new Set(message.seen_by);
  const waiting = message.recipients.filter((h) => !seen.has(h));
  const parts: string[] = [];
  if (seen.size > 0) parts.push(`seen by ${message.seen_by.join(", ")}`);
  if (waiting.length > 0)
    parts.push(`${seen.size > 0 ? "not yet by" : "not seen yet by"} ${waiting.join(", ")}`);
  return parts.join("; ");
}

/** "800 B", "12 KB", "1.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long the server still keeps a file: "7 days left", "3 hours left", "no longer kept". */
export function formatLeft(
  file: Pick<FileRef, "available" | "expires_at">,
  now: Date = new Date(),
): string {
  const ms = Date.parse(file.expires_at) - now.getTime();
  if (!file.available || ms <= 0) return "no longer kept";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "less than an hour left";
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} left`;
  return `${Math.round(ms / 86_400_000)} days left`;
}

/** How the reader gets file number `n`: a command, or a tool for agents that use tools. */
export type GetFileHint = (number: number) => string;
const getByCommand: GetFileHint = (number) => `agentbridge file get ${number}`;

/**
 * A file's name as it can be printed: its sender chose it, so nothing in it may act on a terminal
 * or turn the text around. The server refuses such names; an older or another one may not.
 */
const shownName = (name: string, max: number) => {
  const clean = bare(name);
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
};

/** One line per file a message carries: "[file 3: payments.yaml, 12 KB - get it with: ...]". */
function attachments(message: Message | InboxMessage, hint: GetFileHint): string[] {
  return (message.files ?? []).map((file) => {
    const name = shownName(file.name, 80);
    const state = file.available ? `get it with: ${hint(file.number)}` : "no longer kept";
    return `    [file ${file.number}: ${name}, ${formatSize(file.size)} - ${state}]`;
  });
}

export function formatMessage(
  message: Message | InboxMessage,
  options: { receipts?: boolean; getFile?: GetFileHint } = {},
): string {
  // Board events (someone joined, an agent was added) are one line: "#3 14:02  · bob joined ..."
  if (message.kind === "activity") {
    return `#${message.seq} ${formatTime(message.created_at)}  · ${oneLine(message.body)}`;
  }
  const to = targets(message);
  const parts = [`#${message.seq} ${formatTime(message.created_at)}  ${message.from}`];
  if (to.length > 0) parts[0] += ` → ${to.join(", ")}`;
  if (message.reply_to !== null) parts[0] += `  ↩ #${message.reply_to}`;
  if (message.kind === "human_request") parts[0] += "  [needs a human]";
  const body = message.body
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  const receipts = options.receipts ? formatReceipts(message) : "";
  const files = attachments(message, options.getFile ?? getByCommand).map((line) => `\n${line}`);
  return `${parts[0]}\n${body}${files.join("")}${receipts === "" ? "" : `\n    (${receipts})`}`;
}

export function formatMessages(
  messages: Array<Message | InboxMessage>,
  options: { receipts?: boolean; getFile?: GetFileHint } = {},
): string {
  return messages.map((m) => formatMessage(m, options)).join("\n\n");
}

/**
 *   ● alice/claude  agent  joined today 14:02  wiring /users
 */
export function formatMembers(members: MemberOut[], now: Date = new Date()): string {
  const width = Math.max(6, ...members.map((m) => m.handle.length));
  return members
    .map((m) => {
      const dot = m.online ? "●" : "○";
      // The owner's kind column says so: the same width as "human" and "agent".
      const kind = m.role === "owner" ? "owner" : m.kind;
      const joined = `joined ${formatDay(m.joined_at, now)}`;
      const status = m.status_text ? `  ${oneLine(m.status_text)}` : "";
      return `${dot} ${m.handle.padEnd(width)}  ${kind}  ${joined.padEnd(23)}${status}`.trimEnd();
    })
    .join("\n");
}

/**
 *   📌 context.md   v3  1.2 KB  alice/claude  today 14:02
 *      plan.md      v1  300 B   bob/codex     2026-11-09 18:30
 */
export function formatDocuments(documents: DocumentInfo[], now: Date = new Date()): string {
  const width = Math.max(4, ...documents.map((d) => d.name.length));
  const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  return documents
    .map(
      (d) =>
        `${d.pinned ? "📌" : "  "} ${d.name.padEnd(width)}  v${String(d.version).padEnd(3)} ${size(d.size).padEnd(8)} ${d.updated_by}  ${formatDay(d.updated_at, now)}`,
    )
    .join("\n");
}

/**
 * The parts of the project that people and agents have taken, one line each:
 *
 *   Checkout  alice/claude  web/checkout/**, web/api.ts  today 14:02
 */
export function formatZones(zones: Zone[], now: Date = new Date()): string {
  const name = Math.max(4, ...zones.map((z) => z.name.length));
  const owner = Math.max(5, ...zones.map((z) => z.owner.length));
  // Paths line up too, unless one part lists so many that every other row would be pushed away.
  const paths = Math.min(48, Math.max(5, ...zones.map((z) => z.paths.join(", ").length)));
  return zones
    .map((z) => {
      const where = z.paths.join(", ").padEnd(paths);
      // What is shown on one line stays on one line, even when an older server stored a line
      // break: it would let a member write what looks like the next entry of a listing.
      const note = z.note ? `  (${oneLine(z.note)})` : "";
      const stale = z.stale ? "  [owner not seen for a while]" : "";
      return `${z.name.padEnd(name)}  ${z.owner.padEnd(owner)}  ${where}  ${formatDay(z.claimed_at, now)}${note}${stale}`;
    })
    .join("\n");
}

/** What to tell whoever just took a part that meets somebody else's. Empty when nothing does. */
export function describeOverlaps(overlaps: ZoneOverlap[]): string {
  return overlaps
    .map(
      (o) =>
        `Heads up: this meets ${o.zone.owner}'s "${o.zone.name}" (${o.paths.join(", ")}). ` +
        `They have been told. Agree on a split with: agentbridge post "@${o.zone.owner} ..."\n`,
    )
    .join("");
}

export { inviteMessage } from "@agentbridge/protocol";

interface Posted {
  message: {
    seq: number;
    mentions: string[];
    mention_all: boolean;
    mention_humans: boolean;
    reply_to?: number | null;
  };
}

/**
 * What `post` did, in one line: who got the message in their inbox. A message that mentions
 * nobody is only in the log and the feed, which surprises people, so that case says how to fix it.
 */
export function describeDelivery({ message }: Posted): string {
  const to: string[] = [];
  if (message.mention_all) {
    to.push("everyone on the board");
  } else {
    if (message.mentions.length > 0) to.push(message.mentions.map((h) => `@${h}`).join(", "));
    if (message.mention_humans) to.push("the people on the board");
  }
  if (message.reply_to != null && !message.mention_all)
    to.push(`the author of #${message.reply_to}`);

  if (to.length === 0) {
    return (
      `Posted #${message.seq}. It mentions nobody, so it is in the log and the feed but in no one's inbox. ` +
      "Add @name for one teammate, or @all for everyone."
    );
  }
  const list = to.length === 1 ? to[0] : `${to.slice(0, -1).join(", ")} and ${to.at(-1)}`;
  return `Posted #${message.seq} to ${list}.`;
}

/** One line per task: "#3  doing  Cart totals with discounts  [cart]  bob/claude, bob/codex". */
export function formatTasks(tasks: Task[]): string {
  const number = Math.max(...tasks.map((t) => String(t.number).length)) + 1;
  return tasks
    .map((t) => {
      const part = t.part ? `  [${t.part}]` : "";
      const who = t.agents.length ? `  ${t.agents.join(", ")}` : "";
      return `${`#${t.number}`.padEnd(number)}  ${t.state.padEnd(5)}  ${t.title}${part}${who}`;
    })
    .join("\n");
}

/**
 * The files sent to or by the reader, one line each:
 *
 *   3  payments.yaml  12 KB  alice/claude → bob/codex  7 days left
 */
export function formatFiles(files: FileInfo[], now: Date = new Date()): string {
  const number = Math.max(...files.map((f) => String(f.number).length));
  const names = files.map((f) => shownName(f.name, 40));
  const name = Math.max(4, ...names.map((n) => n.length));
  const size = Math.max(...files.map((f) => formatSize(f.size).length));
  return files
    .map((f, i) => {
      const shown = names[i] as string;
      return `${String(f.number).padStart(number)}  ${shown.padEnd(name)}  ${formatSize(f.size).padEnd(size)}  ${f.from} → ${f.to.join(", ")}  ${formatLeft(f, now)}`;
    })
    .join("\n");
}

/**
 * Who asked to join and waits for the owner:
 *
 *   Waiting to join (only alice can let them in: agentbridge accept <name>):
 *     carol  with carol/claude  asked today 14:02
 */
export function formatWaiting(
  waiting: MemberOut[],
  owner: string | null | undefined,
  now: Date = new Date(),
): string {
  const people = waiting.filter((m) => m.kind === "human");
  if (people.length === 0) return "";
  const who = owner ? `only ${owner} can let them in` : "the owner lets them in";
  const lines = people.map((p) => {
    const agents = waiting.filter((m) => m.handle.startsWith(`${p.handle}/`)).map((m) => m.handle);
    const with_ = agents.length > 0 ? `  with ${agents.join(", ")}` : "";
    return `  ${oneLine(p.handle)}${with_}  asked ${formatDay(p.joined_at, now)}`;
  });
  return `Waiting to join (${who}: agentbridge accept <name>):\n${lines.join("\n")}`;
}

/**
 *   tok_1a2b  invite  needs approval  2 of 5 used  until 2026-11-25  by alice  "for the team"
 */
export function formatLinks(tokens: TokenOut[], now: Date = new Date()): string {
  const id = Math.max(2, ...tokens.map((t) => t.id.length));
  return tokens
    .map((t) => {
      const kind = t.scope === "join" ? "invite" : "feed  ";
      const how =
        t.scope === "read"
          ? "read-only     "
          : t.requires_approval
            ? "needs approval"
            : "open          ";
      const uses = t.max_uses ? `${t.uses} of ${t.max_uses} used` : `${t.uses} used`;
      const until = t.revoked_at
        ? "stopped"
        : t.expires_at
          ? `${new Date(t.expires_at) > now ? "until" : "ended"} ${formatDay(t.expires_at, now)}`
          : "no end";
      const by = t.created_by ? `by ${t.created_by}` : "made with the board";
      const label = t.label ? `  "${oneLine(t.label)}"` : "";
      const ended = t.active ? "" : "  [ended]";
      const scopeUses = t.scope === "join" ? `${uses.padEnd(12)}  ` : "";
      return `${t.id.padEnd(id)}  ${kind}  ${how}  ${scopeUses}${until}  ${by}${label}${ended}`;
    })
    .join("\n");
}

const EVENT_TEXT: Record<string, (subject: string) => string> = {
  board_created: () => "created the board",
  member_joined: () => "joined",
  member_requested: () => "asked to join",
  member_accepted: (s) => `let ${s} in`,
  member_declined: (s) => `turned down ${s}`,
  member_removed: (s) => `took ${s} off the board`,
  member_left: () => "left",
  owner_changed: (s) => `handed the board to ${s}`,
  link_created: (s) => `made the link ${s}`,
  link_revoked: (s) => `stopped the link ${s}`,
};

/**   today 14:02  alice  let carol in */
export function formatSecurityEvents(events: SecurityEvent[], now: Date = new Date()): string {
  const actor = Math.max(4, ...events.map((e) => (e.actor ?? "").length));
  return events
    .map((e) => {
      const subject = oneLine(e.subject ?? "");
      const text = EVENT_TEXT[e.kind]?.(subject) ?? `${e.kind} ${subject}`.trim();
      return `${formatDay(e.created_at, now).padEnd(17)}  ${oneLine(e.actor ?? "").padEnd(actor)}  ${text}`;
    })
    .join("\n");
}
