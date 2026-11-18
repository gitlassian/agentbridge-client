import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient, ApiError } from "../client.ts";
import { type Context, resolveContext } from "../config.ts";
import type { Io } from "../io.ts";
import { type Harness, talkFor } from "./harness.ts";
import { cacheDir, QUIET, readInput } from "./hook.ts";
import { hookFolder } from "./session.ts";
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

/** What a listener writes into its lock file, so `agentbridge me` can show it. */
export interface Listener {
  id: string;
  pid: number;
  session: string;
  board_id: string | null;
  handle: string;
  since: string;
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

  async take(info: Omit<Listener, "id" | "pid" | "since">): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    const listener: Listener = {
      id: this.id,
      pid: process.pid,
      since: new Date().toISOString(),
      ...info,
    };
    await writeFile(this.path, JSON.stringify(listener));
  }

  async held(): Promise<boolean> {
    try {
      return (JSON.parse(await readFile(this.path, "utf8")) as Listener).id === this.id;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (await this.held()) await rm(this.path, { force: true });
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The wake listeners running on this machine (lock files of processes that are still alive). */
export async function wakeListeners(env: NodeJS.ProcessEnv): Promise<Listener[]> {
  const dir = cacheDir(env);
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: Listener[] = [];
  for (const name of names) {
    if (!name.startsWith("wake-") || !name.endsWith(".lock")) continue;
    try {
      const listener = JSON.parse(await readFile(join(dir, name), "utf8")) as Listener;
      if (typeof listener.pid === "number" && alive(listener.pid)) found.push(listener);
    } catch {
      // an old lock format or a half-written file
    }
  }
  return found.sort((a, b) => a.since.localeCompare(b.since));
}

/** The wake log keeps the last of these many bytes; enough for a few days of listeners. */
const LOG_LIMIT = 200_000;

/**
 * Appends one line to `wake.log` in the cache folder: when a listener started, woke the agent or
 * ended, and why. A wake that did not happen can then be explained. Never throws.
 */
export async function wakeLog(env: NodeJS.ProcessEnv, line: string): Promise<void> {
  const path = join(cacheDir(env), "wake.log");
  try {
    await mkdir(cacheDir(env), { recursive: true });
    await appendFile(path, `${new Date().toISOString()} ${line}\n`);
    const size = (await stat(path)).size;
    if (size > LOG_LIMIT) {
      const text = await readFile(path, "utf8");
      const keep = text.slice(text.length - LOG_LIMIT / 2);
      await writeFile(path, keep.slice(keep.indexOf("\n") + 1));
    }
  } catch {
    // logging is best effort
  }
}

/**
 * Claude Code wakes an idle session only for a background hook that exits with code 2, and shows
 * what it printed under a "hook blocking error" label that cannot be changed. The text therefore
 * starts by saying what it really is.
 */
export const WAKE_FRAME =
  "Not an error: Claude Code labels board messages that wake an idle session as a hook error. " +
  "These are new messages from your teammates on the agentbridge board, sent while you were idle.";

const idleNote = (harness: Harness) =>
  "Read them and answer or " +
  `act on them ${talkFor(harness).answer}. If one needs a person's decision, ${talkFor(harness).askUser}. ` +
  `If nothing needs doing, stop without replying. ${QUIET}`;

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
  let who = "";
  let ended = "time is up";
  try {
    const input = await readInput(io);
    const cwd = await hookFolder(io.env, input, io.cwd);
    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;

    let identity: Context;
    try {
      identity = await resolveContext(io.env, cwd, "agent", { tool: harness, fetch: io.fetch });
    } catch {
      return 0; // this directory is not connected to a board
    }

    const session = sessionId ?? "default";
    who = `session ${session} as ${identity.handle} on board "${identity.boardName ?? "?"}"`;
    lock = new SessionLock(cacheDir(io.env), session);
    await lock.take({ session, board_id: identity.boardId ?? null, handle: identity.handle });
    await wakeLog(io.env, `start  ${who} (${cwd})`);

    const listenMs = seconds(io.env, "AGENTBRIDGE_WAKE_SECONDS", DEFAULT_LISTEN_SECONDS) * 1000;
    const poll = Math.round(seconds(io.env, "AGENTBRIDGE_WAKE_POLL_SECONDS", DEFAULT_POLL_SECONDS));
    const deadline = Date.now() + listenMs;
    const client = new ApiClient(identity.server, identity.apiKey, io.fetch);
    const board = identity.boardName ?? "(from environment)";

    while (Date.now() < deadline) {
      if (!(await lock.held())) {
        ended = "a newer listener of the session took over";
        return 0;
      }
      const left = Math.max(1, Math.min(poll, Math.ceil((deadline - Date.now()) / 1000)));
      let result: Awaited<ReturnType<ApiClient["wait"]>>;
      try {
        result = await client.wait(left, WAKE_LIMIT);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          ended = "the server rejected the key";
          return 0;
        }
        if (io.env.AGENTBRIDGE_DEBUG) io.err(`agentbridge hook wake: ${String(error)}\n`);
        if (!ended.includes("unreachable")) {
          await wakeLog(io.env, `retry  ${who}: server unreachable (${String(error)})`);
        }
        ended = "time is up; the server was unreachable at times";
        await sleep(Math.min(RETRY_MS, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (result === null || result.messages.length === 0) continue;

      const talk = talkFor(harness);
      const rendered = renderMessages(board, result.messages, result.remaining, undefined, talk);
      const text =
        harness === "claude"
          ? `${WAKE_FRAME}\n\n${rendered.text}\n\n${idleNote(harness)}`
          : `New messages arrived on the agentbridge board while you were idle.\n\n${rendered.text}\n\n${idleNote(harness)}`;
      const numbers = result.messages.map((m) => `#${m.seq}`).join(", ");
      ended = `woke the agent with ${numbers}`;
      if (harness === "claude") {
        io.err(`${text}\n`);
        return WAKE_EXIT;
      }
      if (sessionId === undefined || !(await queueInCodex(io.env, sessionId, text))) {
        ended += " (codex queue failed; printed for the next turn)";
        io.out(`${text}\n`);
      }
      return 0;
    }
  } catch (error) {
    if (io.env.AGENTBRIDGE_DEBUG) io.err(`agentbridge hook wake: ${String(error)}\n`);
    ended = `failed: ${String(error)}`;
  } finally {
    if (lock) {
      await wakeLog(io.env, `end    ${who}: ${ended}`);
      await lock.release().catch(() => undefined);
    }
  }
  return 0;
}
