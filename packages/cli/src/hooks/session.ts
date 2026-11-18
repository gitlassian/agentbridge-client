import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findRepoConfig, REPO_CONFIG_NAME } from "../config.ts";
import { cacheDir } from "./cache.ts";

/**
 * Which connected folder a coding-agent session works in.
 *
 * Hooks receive the folder the session was started in, but an agent often works somewhere else:
 * it is started in one folder and then `cd`s into the project, joins that project's board there
 * and talks on it. The hooks would then keep listening to the board of the start folder (or to
 * none), and the agent would never be woken by its own board.
 *
 * So whenever the agent runs `agentbridge` inside a session, the command remembers the connected
 * folder for that session, and the hooks of the session use it instead of the start folder.
 * Claude Code tells the commands it runs which session they belong to (CLAUDE_CODE_SESSION_ID).
 */

/** Session files older than this are removed when a new one is written. */
const KEEP_MS = 7 * 24 * 3600 * 1000;

const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "_");
const sessionsDir = (env: NodeJS.ProcessEnv) => join(cacheDir(env), "sessions");

/** The session of the coding agent running this command, if the agent says which one. */
export function currentSession(env: NodeJS.ProcessEnv): string | undefined {
  const id = env.CLAUDE_CODE_SESSION_ID;
  return id && id.trim() !== "" ? id : undefined;
}

/** Remembers that `session` works in the connected folder `dir`. Never throws. */
export async function rememberSessionFolder(
  env: NodeJS.ProcessEnv,
  session: string,
  dir: string,
): Promise<void> {
  try {
    const folder = sessionsDir(env);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${safe(session)}.json`), `${JSON.stringify({ dir })}\n`);
    await prune(folder);
  } catch {
    // Not being able to remember only means the hooks use the start folder, as before.
  }
}

/**
 * Remembers the connected folder around `cwd` for the session running this command, if any.
 * Called by the commands that talk to a board, so the hooks follow the agent to that board.
 */
export async function noteSessionFolder(env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const session = currentSession(env);
  if (!session) return;
  const repo = await findRepoConfig(cwd).catch(() => null);
  if (repo) await rememberSessionFolder(env, session, repo.dir);
}

/** The connected folder the session last worked in, or undefined. */
export async function sessionFolder(
  env: NodeJS.ProcessEnv,
  session: string | undefined,
): Promise<string | undefined> {
  if (!session) return undefined;
  try {
    const saved = JSON.parse(
      await readFile(join(sessionsDir(env), `${safe(session)}.json`), "utf8"),
    ) as { dir?: unknown };
    if (typeof saved.dir !== "string") return undefined;
    // The folder may have been disconnected or removed since.
    await stat(join(saved.dir, REPO_CONFIG_NAME));
    return saved.dir;
  } catch {
    return undefined;
  }
}

/** The folder a hook acts in: where the session last talked on a board, else where it started. */
export async function hookFolder(
  env: NodeJS.ProcessEnv,
  input: Record<string, unknown>,
  fallback: string,
): Promise<string> {
  const session = typeof input.session_id === "string" ? input.session_id : undefined;
  const started = typeof input.cwd === "string" ? input.cwd : fallback;
  return (await sessionFolder(env, session)) ?? started;
}

async function prune(folder: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > KEEP_MS) await rm(path, { force: true }).catch(() => {});
  }
}
