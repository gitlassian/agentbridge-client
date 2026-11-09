import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient, ApiError } from "../client.ts";
import { type Context, resolveContext } from "../config.ts";
import type { Io } from "../io.ts";
import { type Harness, talkFor } from "./harness.ts";
import { cacheDir, readInput } from "./hook.ts";
import { renderMessages } from "./wrap.ts";

/** Exit code that makes Claude Code wake the agent with what the hook printed (`asyncRewake`). */
export const WAKE_EXIT = 2;

/** How long to keep listening after the agent stops. Claude Code's limit for the hook is 3600 s. */
const DEFAULT_LISTEN_SECONDS = 3300;
/** One long-poll. Short enough to notice a newer listener taking over within this time. */
const DEFAULT_POLL_SECONDS = 25;
/** Pause after the server could not be reached, before trying again. */
const RETRY_MS = 5000;
/** At most this many messages per wake, so they always fit in the context Claude Code accepts. */
const WAKE_LIMIT = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * One listener per Claude Code session. A newer listener takes over by writing its own id into
 * the lock file; the older one notices on its next round and ends quietly. Nothing is killed, so
 * Claude Code never sees a hook that failed.
 */
class SessionLock {
  private readonly path: string;
  private readonly id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  constructor(dir: string, sessionId: string) {
    this.path = join(dir, `wake-${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_")}.lock`);
  }

  async take(): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, this.id);
  }

  async held(): Promise<boolean> {
    try {
      return (await readFile(this.path, "utf8")) === this.id;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (await this.held()) await rm(this.path, { force: true });
  }
}

const idleNote = (harness: Harness) =>
  "New messages arrived on the agentbridge board while you were idle. Read them and answer or " +
  `act on them ${talkFor(harness).answer}. If nothing needs doing, stop without replying.`;

/** How long `codex queue` may take to hand the message over. */
const QUEUE_TIMEOUT_MS = 30_000;

/**
 * Hands the messages to an idle Codex session as a new user turn (`codex queue`). Codex starts the
 * turn at once when the session is idle, or right after the current one. Resolves to false when
 * Codex could not take it (not installed, too old, session gone).
 */
export function queueInCodex(
  env: NodeJS.ProcessEnv,
  threadId: string,
  text: string,
): Promise<boolean> {
  const command = env.AGENTBRIDGE_CODEX_COMMAND || "codex";
  return new Promise((resolve) => {
    execFile(
      command,
      ["queue", "--thread", threadId, "--message", text],
      { env, timeout: QUEUE_TIMEOUT_MS },
      (error) => resolve(error === null),
    );
  });
}

/**
 * The background wake hook (`agentbridge hook wake`). Claude Code or Codex starts it after the
 * agent stops and leaves it running. It long-polls the board; as soon as something is addressed
 * to this agent it wakes the agent with the messages:
 * - Claude Code: prints them and exits with code 2 (`asyncRewake`);
 * - Codex: queues them in the session with `codex queue`, which starts a new turn. If that fails,
 *   it prints them, and Codex adds a background hook's output to the next turn.
 *
 * Like every hook it must never get in the agent's way: when the directory is not connected, the
 * key is rejected or the time is up, it ends with code 0 and prints nothing. Messages are marked
 * as read by the server in the same step that returns them, so they are never delivered twice.
 */
export async function runWake(io: Io, harness: Harness = "claude"): Promise<number> {
  let lock: SessionLock | null = null;
  try {
    const input = await readInput(io);
    const cwd = typeof input.cwd === "string" ? input.cwd : io.cwd;
    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;

    let identity: Context;
    try {
      identity = await resolveContext(io.env, cwd, "agent", { tool: harness, fetch: io.fetch });
    } catch {
      return 0; // this directory is not connected to a board
    }

    lock = new SessionLock(cacheDir(io.env), sessionId ?? "default");
    await lock.take();

    const listenMs = seconds(io.env, "AGENTBRIDGE_WAKE_SECONDS", DEFAULT_LISTEN_SECONDS) * 1000;
    const poll = Math.round(seconds(io.env, "AGENTBRIDGE_WAKE_POLL_SECONDS", DEFAULT_POLL_SECONDS));
    const deadline = Date.now() + listenMs;
    const client = new ApiClient(identity.server, identity.apiKey, io.fetch);
    const board = identity.boardName ?? "(from environment)";

    while (Date.now() < deadline) {
      if (!(await lock.held())) return 0; // a newer listener took over
      const left = Math.max(1, Math.min(poll, Math.ceil((deadline - Date.now()) / 1000)));
      let result: Awaited<ReturnType<ApiClient["wait"]>>;
      try {
        result = await client.wait(left, WAKE_LIMIT);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return 0;
        if (io.env.AGENTBRIDGE_DEBUG) io.err(`agentbridge hook wake: ${String(error)}\n`);
        await sleep(Math.min(RETRY_MS, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (result === null || result.messages.length === 0) continue;

      const talk = talkFor(harness);
      const rendered = renderMessages(board, result.messages, result.remaining, undefined, talk);
      const text = `${rendered.text}\n\n${idleNote(harness)}`;
      if (harness === "claude") {
        io.err(`${text}\n`);
        return WAKE_EXIT;
      }
      if (sessionId === undefined || !(await queueInCodex(io.env, sessionId, text))) {
        io.out(`${text}\n`);
      }
      return 0;
    }
  } catch (error) {
    if (io.env.AGENTBRIDGE_DEBUG) io.err(`agentbridge hook wake: ${String(error)}\n`);
  } finally {
    await lock?.release().catch(() => undefined);
  }
  return 0;
}
