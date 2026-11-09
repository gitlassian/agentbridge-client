import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InboxMessage, MemberOut } from "@agentbridge/protocol";
import { ApiClient } from "../client.ts";
import { type Context, resolveContext } from "../config.ts";
import type { Io } from "../io.ts";
import { type Harness, talkFor } from "./harness.ts";
import { renderIntro, renderMessages } from "./wrap.ts";

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

export function cacheDir(env: NodeJS.ProcessEnv): string {
  if (env.AGENTBRIDGE_CACHE_DIR) return env.AGENTBRIDGE_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "agentbridge");
  return join(env.HOME ?? homedir(), ".cache", "agentbridge");
}

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

export async function readInput(io: Io): Promise<Record<string, unknown>> {
  if (io.interactive) return {}; // run by hand, nothing is piped in
  try {
    const parsed: unknown = JSON.parse(await io.readStdin());
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The text a hook adds to the agent's context, or null when there is nothing to say. */
function output(name: HookName, context: string): string {
  if (name === "stop") {
    // Keeps the agent working instead of stopping: new messages need an answer first.
    return JSON.stringify({ decision: "block", reason: context });
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: EVENT_NAME[name], additionalContext: context },
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
    const cwd = typeof input.cwd === "string" ? input.cwd : io.cwd;

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
    const [inbox, members] = await Promise.all([
      client.inbox({ ack: false, limit: 20 }).catch(() => null),
      name === "session-start" ? client.members().catch(() => null) : Promise.resolve(null),
    ]);

    const messages: InboxMessage[] = inbox?.messages ?? [];
    const board = identity.boardName ?? "(from environment)";
    const talk = talkFor(harness);
    const parts: string[] = [];

    if (name === "session-start") {
      const list: MemberOut[] = members?.members ?? [];
      parts.push(renderIntro(board, identity.handle, list, talk));
    }
    if (messages.length > 0) {
      const rendered = renderMessages(board, messages, inbox?.remaining ?? 0, undefined, talk);
      parts.push(rendered.text);
      if (name === "stop") {
        parts.push(`Read these and answer or act on them before you finish, ${talk.answer}.`);
      }

      // Mark as read only what is about to be shown. The messages that did not fit stay unread
      // and arrive with the next hook. If this fails the same messages may be shown twice,
      // which is better than losing them.
      const lastShown = messages[rendered.shown - 1];
      if (lastShown) await client.ack(lastShown.seq).catch(() => undefined);
    }
    if (parts.length === 0) return 0;

    io.out(`${output(name, parts.join("\n\n"))}\n`);
  } catch (error) {
    if (io.env.AGENTBRIDGE_DEBUG) io.err(`agentbridge hook ${name}: ${String(error)}\n`);
  }
  return 0;
}
