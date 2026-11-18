import { homedir } from "node:os";
import { join } from "node:path";

/** Where the hooks keep small files: throttling marks, wake locks, session folders. */
export function cacheDir(env: NodeJS.ProcessEnv): string {
  if (env.AGENTBRIDGE_CACHE_DIR) return env.AGENTBRIDGE_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "agentbridge");
  return join(env.HOME ?? homedir(), ".cache", "agentbridge");
}
