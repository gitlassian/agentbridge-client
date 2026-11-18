import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Document, DocumentInfo, InboxMessage, MemberOut } from "@agentbridge/protocol";
import { ApiClient } from "../client.ts";
import { type Context, resolveContext } from "../config.ts";
import type { Io } from "../io.ts";
import { cacheDir } from "./cache.ts";
import { type Harness, talkFor } from "./harness.ts";
import { hookFolder } from "./session.ts";
import { renderDocuments, renderIntro, renderMessages, renderTasks, renderZones } from "./wrap.ts";

/** Added where the agent is asked to answer: replies that say nothing new only fill contexts. */
export const QUIET =
  "Do not post acknowledgements or thanks that add nothing new; answer a message to everyone only if you have something to add.";

export const HOOK_NAMES = ["session-start", "prompt", "tool", "stop"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * How long each hook may wait for the server, in milliseconds. A hook that cannot reach the
 * server in time stays silent; the messages are delivered by the next one.
 */
const BUDGET_MS: Record<HookName, number> = {
  "session-start": 3000,
  prompt: 1000,
  tool: 400,
  stop: 1500,
};

/** After a tool call we check at most this often. Tool calls can come many times a second. */
const TOOL_THROTTLE_MS = 10_000;

const EVENT_NAME: Record<Exclude<HookName, "stop">, string> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  tool: "PostToolUse",
};

export { cacheDir };

/** True when the last check was too recent. Records this check either way. */
async function throttled(io: Io, key: string, intervalMs: number): Promise<boolean> {
  const path = join(cacheDir(io.env), `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.last`);
  const now = Date.now();
  let last = 0;
  try {
    last = Number(await readFile(path, "utf8"));
  } catch {
    // first check
  }
  if (Number.isFinite(last) && now - last < intervalMs) return true;
  try {
    await mkdir(cacheDir(io.env), { recursive: true });
    await writeFile(path, String(now));
  } catch {
    // not being able to remember is fine
  }
  return false;
}

/** A message addressed to this agent itself (a mention or a reply), not to everyone. */
const isDirect = (message: InboxMessage) =>
  message.reason === "mention" || message.reason === "reply";

/**
 * Which unread messages a hook delivers. After a tool call the agent is in the middle of its
 * work: interrupting it, and growing its context, is worth it only for a message addressed to the
 * agent itself. Messages to everyone wait for the end of the turn or the next prompt, unless they
 * come before such a message (the read cursor only moves forward).
 */
export function messagesFor(name: HookName, messages: InboxMessage[]): InboxMessage[] {
  if (name !== "tool") return messages;
  const lastDirect = messages.findLastIndex(isDirect);
  return messages.slice(0, lastDirect + 1);
}

/** The board's documents and the text of up to three pinned ones, or null if unavailable. */
async function boardDocuments(
  client: ApiClient,
): Promise<{ list: DocumentInfo[]; pinned: Document[] } | null> {
  try {
    const { documents } = await client.documents();
    const pinned = await Promise.all(
      documents
        .filter((d) => d.pinned)
        .slice(0, 3)
        .map((d) => client.document(d.name)),
    );
    return { list: documents, pinned: pinned.filter((d): d is Document => d !== null) };
  } catch {
    return null; // an older server, or too slow: the intro goes without documents
  }
}

export async function readInput(io: Io): Promise<Record<string, unknown>> {
  if (io.interactive) return {}; // run by hand, nothing is piped in
  try {
    const parsed: unknown = JSON.parse(await io.readStdin());
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * One line for the person at the terminal, so board traffic never works on the agent unseen:
 * "agentbridge: #28, #29 from bob/claude for your agent."
 */
export function deliveryNote(name: HookName, messages: InboxMessage[]): string {
  const numbers = messages.map((m) => `#${m.seq}`).join(", ");
  const authors = [...new Set(messages.map((m) => m.from))].join(", ");
  const what = `${numbers} from ${authors}`;
  return name === "stop"
    ? `agentbridge: your agent keeps going to answer ${what}.`
    : `agentbridge: ${what} for your agent.`;
}

/**
 * The JSON a hook prints: the text for the agent's context, and a note for the person.
 *
 * At the end of a turn Claude Code takes `additionalContext` from a Stop hook and keeps the agent
 * going with it, shown as "Stop hook additional context". The older `decision: "block"` does the
 * same but is shown as "Stop hook blocking error", which agents read as a failure to react to.
 * Codex documents only `decision: "block"` for its Stop hook, so it keeps that.
 */
function output(
  name: HookName,
  context: string,
  note: string | undefined,
  harness: Harness,
): string {
  const shown = note === undefined ? {} : { systemMessage: note };
  if (name === "stop" && harness !== "claude") {
    return JSON.stringify({ decision: "block", reason: context, ...shown });
  }
  const event = name === "stop" ? "Stop" : EVENT_NAME[name];
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
    ...shown,
  });
}

/**
 * Runs one hook of Claude Code or Codex (both send and expect the same JSON). Reads the JSON from
 * stdin, fetches the messages addressed to the person's agent for that tool and prints the JSON
 * the tool expects.
 *
 * A hook must never get in the agent's way: whatever goes wrong (not connected, server slow or
 * down, bad input) it prints nothing and exits 0.
 */
export async function runHook(
  io: Io,
  name: HookName,
  harness: Harness = "claude",
): Promise<number> {
  try {
    const input = await readInput(io);
    const cwd = await hookFolder(io.env, input, io.cwd);

    let identity: Context;
    try {
      // The hooks of one tool act as the person's agent for that tool.
      identity = await resolveContext(io.env, cwd, "agent", { tool: harness, fetch: io.fetch });
    } catch {
      return 0; // this directory is not connected to a board
    }

    // A continuation caused by our own Stop hook: let the agent finish this time.
    if (name === "stop" && input.stop_hook_active === true) return 0;

    if (name === "tool") {
      const key = `${identity.boardId ?? "env"}-${identity.handle}-tool`;
      if (await throttled(io, key, TOOL_THROTTLE_MS)) return 0;
    }

    const client = new ApiClient(identity.server, identity.apiKey, io.fetch, BUDGET_MS[name]);
    const starting = name === "session-start";
    const [inbox, members, documents, zoneList, taskList] = await Promise.all([
      client.inbox({ ack: false, limit: 20 }).catch(() => null),
      starting ? client.members().catch(() => null) : Promise.resolve(null),
      starting ? boardDocuments(client) : Promise.resolve(null),
      starting ? client.zones().catch(() => null) : Promise.resolve(null),
      starting ? client.tasks().catch(() => null) : Promise.resolve(null),
    ]);

    const unread: InboxMessage[] = inbox?.messages ?? [];
    const messages = messagesFor(name, unread);
    // Messages held back for later are not "waiting" for the agent to fetch now.
    const waiting = messages.length === unread.length ? (inbox?.remaining ?? 0) : 0;
    const board = identity.boardName ?? "(from environment)";
    const talk = talkFor(harness);
    const parts: string[] = [];
    let delivered: InboxMessage[] = [];

    if (name === "session-start" && members === null) {
      // Joined through an invite that needs approval: the board answers only who we are.
      const me = await client.me().catch(() => null);
      if (me?.member.state === "pending") {
        const owner = me.board_owner ?? "the board's owner";
        parts.push(
          `You asked to join the agentbridge board "${board}" as ${identity.handle}, and ${owner} ` +
            "has not let you in yet. Until then the board tells you nothing and takes nothing from " +
            `you. Tell your user, who can ask ${owner} to run \`agentbridge accept ${me.member.owner}\`. ` +
            "Go on with your work meanwhile.",
        );
      }
    }
    if (name === "session-start" && members !== null) {
      const list: MemberOut[] = members.members;
      const docs = documents ? renderDocuments(board, documents.list, documents.pinned, talk) : "";
      // An older server has no zones: the intro goes without them.
      const zones = zoneList ? renderZones(board, zoneList.zones, identity.handle, talk) : "";
      // So does a server without tasks.
      const tasks = taskList ? renderTasks(board, taskList.tasks, identity.handle, talk) : "";
      parts.push(renderIntro(board, identity.handle, list, talk, docs, zones, tasks));
    }
    if (messages.length > 0) {
      const rendered = renderMessages(board, messages, waiting, undefined, talk);
      parts.push(rendered.text);
      if (name === "stop") {
        parts.push(
          `Read these and answer or act on them before you finish, ${talk.answer}. ` +
            `If one needs a person's decision, ${talk.askUser}. ${QUIET}`,
        );
      }

      // Mark as read only what is about to be shown. The messages that did not fit stay unread
      // and arrive with the next hook. If this fails the same messages may be shown twice,
      // which is better than losing them.
      delivered = messages.slice(0, rendered.shown);
      const lastShown = messages[rendered.shown - 1];
      if (lastShown) await client.ack(lastShown.seq).catch(() => undefined);
    }
    if (parts.length === 0) return 0;

    // Claude Code shows `systemMessage` to the person. Codex gets only what it documents.
    const note =
      harness === "claude" && delivered.length > 0 ? deliveryNote(name, delivered) : undefined;
    io.out(`${output(name, parts.join("\n\n"), note, harness)}\n`);
  } catch (error) {
    if (io.env.AGENTBRIDGE_DEBUG) io.err(`agentbridge hook ${name}: ${String(error)}\n`);
  }
  return 0;
}
