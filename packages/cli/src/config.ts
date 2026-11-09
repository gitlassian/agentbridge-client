import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { chooseAgent, detectAgent, toolFromName } from "./agents.ts";
import { ApiClient, ApiError } from "./client.ts";
import { CliError } from "./io.ts";

/** `.agentbridge.json` in the repository: which board this repository belongs to. No secrets. */
export interface RepoConfig {
  server: string;
  board_id: string;
  board_name: string;
}

export interface Identity {
  handle: string;
  api_key: string;
}

export interface AgentIdentity extends Identity {
  /** The coding tool this agent was created from ("claude", "codex", ...), when known. */
  tool?: string;
}

/** What is stored per board in the user's credentials file. */
export interface BoardCredentials {
  server: string;
  owner: string;
  human: Identity;
  /** The person's agents on this board, by name ("claude" for alice/claude). */
  agents: Record<string, AgentIdentity>;
}

/** The stored shape, including files written before a person could have several agents. */
interface StoredBoardCredentials {
  server: string;
  owner: string;
  human: Identity;
  agents?: Record<string, AgentIdentity>;
  /** Before several agents: the only one. */
  agent?: Identity;
}

interface CredentialsFile {
  boards: Record<string, BoardCredentials>;
}

/** The part of a handle after the owner: "claude" for "alice/claude". */
export const agentName = (handle: string): string => handle.slice(handle.indexOf("/") + 1);

/** Reads one board's entry, moving a single `agent` from older files into `agents`. */
function normalize(stored: StoredBoardCredentials): BoardCredentials {
  const agents: Record<string, AgentIdentity> = { ...(stored.agents ?? {}) };
  if (stored.agent && !Object.values(agents).some((a) => a.handle === stored.agent?.handle)) {
    const name = agentName(stored.agent.handle);
    const tool = toolFromName(name);
    agents[name] = { ...stored.agent, ...(tool ? { tool } : {}) };
  }
  return { server: stored.server, owner: stored.owner, human: stored.human, agents };
}

export const REPO_CONFIG_NAME = ".agentbridge.json";

/** Where the user's secrets live: ~/.config/agentbridge (or $XDG_CONFIG_HOME/agentbridge). */
export function configDir(env: NodeJS.ProcessEnv): string {
  if (env.AGENTBRIDGE_CONFIG_DIR) return env.AGENTBRIDGE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "agentbridge");
  return join(homedir(), ".config", "agentbridge");
}

const credentialsPath = (env: NodeJS.ProcessEnv) => join(configDir(env), "credentials.json");

async function readJson<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(`${path} is not valid JSON`, {
      hint: "Fix or delete the file and run `agentbridge init` again.",
    });
  }
}

/** Writes a file readable only by the owner, replacing it atomically. */
async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export async function readCredentials(env: NodeJS.ProcessEnv): Promise<CredentialsFile> {
  const file = await readJson<{ boards?: Record<string, StoredBoardCredentials> }>(
    credentialsPath(env),
  );
  const boards: Record<string, BoardCredentials> = {};
  for (const [id, stored] of Object.entries(file?.boards ?? {})) boards[id] = normalize(stored);
  return { boards };
}

export async function saveBoardCredentials(
  env: NodeJS.ProcessEnv,
  boardId: string,
  credentials: BoardCredentials,
): Promise<void> {
  const file = await readCredentials(env);
  file.boards[boardId] = credentials;
  await writePrivate(credentialsPath(env), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Adds one agent to a board's entry. Reads the file again first, so an agent another process
 * added in the meantime is kept.
 */
export async function saveAgent(
  env: NodeJS.ProcessEnv,
  boardId: string,
  name: string,
  agent: AgentIdentity,
): Promise<void> {
  const file = await readCredentials(env);
  const board = file.boards[boardId];
  if (!board) throw new CliError("No credentials for this board on this machine.");
  board.agents[name] = agent;
  await writePrivate(credentialsPath(env), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Registers a new agent for the person on the server and stores its key. When another process
 * registered the same agent a moment earlier, its stored key is used instead.
 */
export async function registerAgent(
  env: NodeJS.ProcessEnv,
  boardId: string,
  credentials: BoardCredentials,
  name: string,
  tool: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentIdentity> {
  const client = new ApiClient(credentials.server, credentials.human.api_key, fetchImpl);
  try {
    const created = await client.addAgent(name);
    const agent: AgentIdentity = {
      handle: created.handle,
      api_key: created.api_key,
      ...(tool ? { tool } : {}),
    };
    await saveAgent(env, boardId, name, agent);
    return agent;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const stored = (await readCredentials(env)).boards[boardId]?.agents[name];
      if (stored) return stored;
      throw new CliError(error.message, {
        hint: error.message.includes("already on this board")
          ? `Its key is not on this machine. Pick another name with --agent <name>.`
          : "Remove an agent you no longer use, or reuse one with --agent <name>.",
      });
    }
    throw error;
  }
}

/** Looks for .agentbridge.json in `cwd` and then in each parent directory. */
export async function findRepoConfig(
  cwd: string,
): Promise<{ path: string; dir: string; config: RepoConfig } | null> {
  let dir = cwd;
  for (;;) {
    const path = join(dir, REPO_CONFIG_NAME);
    const config = await readJson<RepoConfig>(path);
    if (config) return { path, dir, config };
    if (dir === parse(dir).root) return null;
    dir = dirname(dir);
  }
}

export async function writeRepoConfig(dir: string, config: RepoConfig): Promise<string> {
  const path = join(dir, REPO_CONFIG_NAME);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export type Role = "human" | "agent";

export interface Context {
  server: string;
  apiKey: string;
  handle: string;
  boardId: string | undefined;
  boardName: string | undefined;
  role: Role;
  /** Set when this call registered the agent it acts as (a new agent of the person). */
  registered?: boolean;
}

export interface AgentWanted {
  /** The agent's name (`--agent`); AGENTBRIDGE_AGENT when not given. */
  agent?: string | undefined;
  /** The coding tool running the command; detected from the environment when not given. */
  tool?: string | undefined;
  fetch?: typeof fetch;
}

/**
 * Works out which server, board and identity a command acts as.
 *
 * AGENTBRIDGE_SERVER and AGENTBRIDGE_API_KEY override everything (useful in scripts and CI).
 * Otherwise the repository's .agentbridge.json names the board and the credentials file
 * holds the keys. By default commands act as the human; `--as agent` uses the key of one of
 * the person's agents (see `chooseAgent`), registering a new agent when a new tool shows up.
 */
export async function resolveContext(
  env: NodeJS.ProcessEnv,
  cwd: string,
  role: Role,
  wanted: AgentWanted = {},
): Promise<Context> {
  if (env.AGENTBRIDGE_SERVER && env.AGENTBRIDGE_API_KEY) {
    return {
      server: env.AGENTBRIDGE_SERVER.replace(/\/+$/, ""),
      apiKey: env.AGENTBRIDGE_API_KEY,
      handle: "(from environment)",
      boardId: undefined,
      boardName: undefined,
      role,
    };
  }

  const repo = await findRepoConfig(cwd);
  if (!repo) {
    throw new CliError("This directory is not connected to a board.", {
      hint: "Run `agentbridge init` (or `agentbridge init --join <invite link>`).",
    });
  }

  const credentials = (await readCredentials(env)).boards[repo.config.board_id];
  if (!credentials) {
    throw new CliError(`No credentials for board "${repo.config.board_name}" on this machine.`, {
      hint: `Join it with \`agentbridge init --join <invite link> --force\`.`,
    });
  }

  let identity: Identity = credentials.human;
  let registered = false;
  if (role === "agent") {
    const name = wanted.agent ?? (env.AGENTBRIDGE_AGENT || undefined);
    const tool = wanted.tool ?? detectAgent(env);
    const choice = chooseAgent(credentials.agents, { name, tool });
    if (choice.kind === "found") {
      identity = credentials.agents[choice.name] as AgentIdentity;
    } else if (choice.kind === "register") {
      identity = await registerAgent(
        env,
        repo.config.board_id,
        credentials,
        choice.name,
        choice.tool,
        wanted.fetch,
      );
      registered = true;
    } else if (choice.kind === "none") {
      throw new CliError("You have no agent on this board yet.", {
        hint: "Add one with `agentbridge init --agent <name>` (for example claude or codex).",
      });
    } else {
      throw new CliError(`You have several agents here: ${choice.names.join(", ")}.`, {
        hint: "Say which one with --agent <name> or AGENTBRIDGE_AGENT=<name>.",
      });
    }
  }

  return {
    server: credentials.server.replace(/\/+$/, ""),
    apiKey: identity.api_key,
    handle: identity.handle,
    boardId: repo.config.board_id,
    boardName: repo.config.board_name,
    role,
    ...(registered ? { registered } : {}),
  };
}
