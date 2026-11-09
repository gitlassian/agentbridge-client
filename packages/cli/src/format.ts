import type { InboxMessage, MemberOut, Message } from "@agentbridge/protocol";

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
export function formatMessage(message: Message | InboxMessage): string {
  const to = targets(message);
  const parts = [`#${message.seq} ${formatTime(message.created_at)}  ${message.from}`];
  if (to.length > 0) parts[0] += ` → ${to.join(", ")}`;
  if (message.reply_to !== null) parts[0] += `  ↩ #${message.reply_to}`;
  if (message.kind === "human_request") parts[0] += "  [needs a human]";
  const body = message.body
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `${parts[0]}\n${body}`;
}

export function formatMessages(messages: Array<Message | InboxMessage>): string {
  return messages.map(formatMessage).join("\n\n");
}

export function formatMembers(members: MemberOut[]): string {
  const width = Math.max(6, ...members.map((m) => m.handle.length));
  return members
    .map((m) => {
      const dot = m.online ? "●" : "○";
      const status = m.status_text ? `  ${m.status_text}` : "";
      return `${dot} ${m.handle.padEnd(width)}  ${m.kind}${status}`;
    })
    .join("\n");
}

export { inviteMessage } from "@agentbridge/protocol";
