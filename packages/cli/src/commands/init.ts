import { execFile } from "node:child_process";
import { basename } from "node:path";
import { DEFAULT_SERVER, parseHandle } from "@agentbridge/protocol";
import { codexHookStatus, installHooks, userHooksActive } from "../adapters/claude-code/install.ts";
import { HOOK_EVENTS } from "../adapters/claude-code/settings.ts";
import { detectAgent, toolFromName } from "../agents.ts";
import { ApiClient, ApiError } from "../client.ts";
import type { Command, CommandContext } from "../command.ts";
import {
  type AgentIdentity,
  type BoardCredentials,
  findRepoConfig,
  type Identity,
  readCredentials,
  registerAgent,
  saveBoardCredentials,
  writeRepoConfig,
} from "../config.ts";
import { inviteMessage } from "../format.ts";
import { CliError, EXIT, UsageError } from "../io.ts";
import { describeInstall } from "./claude-code.ts";
import { stringValue } from "./shared.ts";

const DEFAULT_AGENT = "claude";

/** Accepts an invite link (https://host/join/<token>) or a bare token. */
export function parseJoin(input: string): { server: string | undefined; token: string } {
  if (!/^https?:\/\//i.test(input)) return { server: undefined, token: input };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`"${input}" is not a valid invite link.`);
  }
  const marker = url.pathname.lastIndexOf("/join/");
  const token =
    marker === -1 ? "" : url.pathname.slice(marker + "/join/".length).replace(/\/+$/, "");
  if (!token) {
    throw new UsageError(
      `"${input}" is not an invite link.`,
      "It should look like https://host/join/inv_...",
    );
  }
  return { server: url.origin + url.pathname.slice(0, marker), token };
}

/** "Jane Doe" -> "jane-doe": a valid handle derived from a user name. */
export function suggestOwner(name: string | undefined): string | undefined {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug === "" ? undefined : slug;
}

export { detectAgent } from "../agents.ts";

/** The tool to remember for a new agent: the one running the command, or the agent's name. */
const toolFor = (env: NodeJS.ProcessEnv, name: string) => detectAgent(env) ?? toolFromName(name);

const invalidInvite = () =>
  new CliError("The invite link is invalid, expired or has been revoked.", {
    hint: "Ask your teammate for a new one (`agentbridge invite`).",
  });

/** `git config user.name`, or undefined when git or the setting is not there. */
function gitUserName(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["config", "user.name"], { cwd, env, timeout: 2000 }, (error, stdout) => {
      const name = error ? "" : String(stdout).trim();
      resolve(name === "" ? undefined : name);
    });
  });
}

/** "alice" -> "alice-2", keeping within the 32 characters a name may have. */
function withSuffix(name: string, n: number): string {
  const suffix = `-${n}`;
  return `${name.slice(0, 32 - suffix.length)}${suffix}`;
}

async function valueOrAsk(
  context: CommandContext,
  flag: string,
  question: string,
  defaultValue: string | undefined,
  options: { required: boolean },
): Promise<string> {
  const given = stringValue(context.values, flag);
  if (given !== undefined) return given;
  if (context.io.interactive) {
    const answer = (await context.io.ask(question, defaultValue)).trim();
    if (answer !== "") return answer;
  } else if (defaultValue !== undefined && !options.required) {
    return defaultValue;
  }
  throw new UsageError(`Missing --${flag}.`, `Pass --${flag} <value> (there is nobody to ask).`);
}

/** The agent name from --agent, a terminal question, or the tool running the command. */
async function askAgentName(context: CommandContext, owner: string): Promise<string | undefined> {
  if (context.values["no-agent"] === true) return undefined;
  const name = await valueOrAsk(
    context,
    "agent",
    "Name of your coding agent",
    detectAgent(context.io.env) ?? DEFAULT_AGENT,
    { required: false },
  );
  if (parseHandle(`${owner}/${name}`)?.kind !== "agent") {
    throw new UsageError(`"${name}" is not a valid agent name.`);
  }
  return name;
}

type ClaudeCodeState = "installed" | "already-active" | "skipped" | "codex-not-set-up" | null;

/**
 * Claude Code hooks, only with an agent: after `agentbridge setup` they are already active
 * everywhere. Otherwise when asked (--claude-code, or a yes in a terminal), and by default when
 * Claude Code itself runs this command, so that an agent joining a board starts receiving
 * messages without its person doing anything.
 */
async function claudeCodeHooks(
  context: CommandContext,
  hasAgent: boolean,
  dir: string,
): Promise<{ state: ClaudeCodeState; text: string }> {
  const { io, values } = context;
  if (!hasAgent) return { state: null, text: "" };
  if (detectAgent(io.env) === "codex") {
    // Codex is set up once per machine by `agentbridge setup`, never per repository.
    const codex = await codexHookStatus(io.env);
    return { state: codex.events.length > 0 ? null : "codex-not-set-up", text: "" };
  }
  if (await userHooksActive(io.env)) return { state: "already-active", text: "" };
  const insideClaudeCode = detectAgent(io.env) === "claude";
  const wants =
    values["claude-code"] === true ||
    (values["no-claude-code"] !== true &&
      (insideClaudeCode ||
        (io.interactive && values["claude-code"] === undefined
          ? /^y/i.test(
              (
                await io.ask("Add agentbridge hooks to Claude Code in this repository? (y/n)", "y")
              ).trim(),
            )
          : false)));
  if (!wants) return { state: "skipped", text: "" };
  const report = await installHooks({
    env: io.env,
    cwd: dir,
    scope: "project",
    command: "agentbridge",
    events: HOOK_EVENTS,
    dryRun: false,
  });
  return { state: "installed", text: await describeInstall(report, "agentbridge", io.env) };
}

function claudeCodeText(state: ClaudeCodeState, installText: string): string {
  if (state === "already-active") {
    return "\nClaude Code hooks are already active for all your projects (agentbridge setup).\n";
  }
  if (state === "installed") return `\n${installText}\n`;
  if (state === "codex-not-set-up") {
    return "\nTo let Codex receive messages automatically: agentbridge setup (once per machine), then restart Codex.\n";
  }
  if (state === "skipped") {
    return "\nTo let Claude Code receive messages automatically: agentbridge setup (once per machine)\n";
  }
  return "";
}

/**
 * The person is already on this board from this machine (another repository, or another agent
 * in this one): keep their account and add the agent if it is new, instead of joining again.
 */
async function addToBoard(
  context: CommandContext,
  board: { id: string; name: string },
  credentials: BoardCredentials,
  dir: string,
): Promise<number> {
  const { io } = context;
  const name = await askAgentName(context, credentials.owner);
  let agent: AgentIdentity | undefined;
  let added = false;
  if (name !== undefined) {
    agent = credentials.agents[name];
    if (!agent) {
      agent = await registerAgent(
        io.env,
        board.id,
        credentials,
        name,
        toolFor(io.env, name),
        io.fetch,
      );
      added = true;
    }
  }
  const path = await writeRepoConfig(dir, {
    server: credentials.server,
    board_id: board.id,
    board_name: board.name,
  });
  const hooks = await claudeCodeHooks(context, agent !== undefined, dir);

  if (context.json) {
    io.out(
      `${JSON.stringify({
        board,
        server: credentials.server,
        human: credentials.human.handle,
        agent: agent?.handle ?? null,
        agents: Object.values({
          ...credentials.agents,
          ...(agent && name ? { [name]: agent } : {}),
        })
          .map((a) => a.handle)
          .sort(),
        already_member: true,
        agent_added: added,
        renamed: false,
        config: path,
        invite_url: null,
        invite_message: null,
        feed_url: null,
        claude_code: hooks.state,
      })}\n`,
    );
    return EXIT.ok;
  }

  io.out(`You are already on board "${board.name}" as ${credentials.human.handle}.\n`);
  if (agent && added) io.out(`Added your agent ${agent.handle}.\n`);
  else if (agent) io.out(`Your agent ${agent.handle} is already set up.\n`);
  io.out(`Wrote ${path} (no secrets; commit it so teammates use the same board).\n`);
  io.out(claudeCodeText(hooks.state, hooks.text));
  return EXIT.ok;
}

export const init: Command = {
  name: "init",
  summary: "Connect this directory to a board (create one, or join with an invite link)",
  usage:
    "agentbridge init [--server URL] [--name BOARD] [--owner NAME] [--agent NAME | --no-agent]\n" +
    "       agentbridge init --join <invite link> [--owner NAME] [--agent NAME | --no-agent]\n" +
    "       add --force to replace an existing connection, --claude-code to add Claude Code hooks\n" +
    "\n" +
    "Without flags, names are picked for you when nobody can be asked: your git user.name (or login)\n" +
    "and the agent that runs the command (claude, codex, ...). A picked name that is taken gets a\n" +
    "number. Run inside Claude Code, the hooks are added unless --no-claude-code or agentbridge setup.\n" +
    "\n" +
    "Already on the board from this machine (another repository, or another agent here)? Then init\n" +
    "keeps your account and adds the agent: one person can have several (alice/claude, alice/codex).",
  options: {
    server: { type: "string" },
    name: { type: "string" },
    owner: { type: "string" },
    agent: { type: "string" },
    "no-agent": { type: "boolean" },
    join: { type: "string" },
    force: { type: "boolean" },
    "claude-code": { type: "boolean" },
    "no-claude-code": { type: "boolean" },
  },
  async run(context) {
    const { io, values } = context;

    const force = values.force === true;
    const existing = await findRepoConfig(io.cwd);
    const joinInput = stringValue(values, "join");
    const join = joinInput === undefined ? undefined : parseJoin(joinInput);
    const stored = (await readCredentials(io.env)).boards;
    const alreadyConnected = (name: string, path: string) =>
      new CliError(`This directory is already connected to board "${name}" (${path}).`, {
        hint: "Use --force to connect it to a different board.",
      });

    // Connected here already, and no invite: add an agent (or report that all is set up).
    // --server or --name ask for a new board, which replaces the connection only with --force.
    const wantsNewBoard =
      stringValue(values, "server") !== undefined || stringValue(values, "name") !== undefined;
    if (existing && !join && !force && !wantsNewBoard) {
      const credentials = stored[existing.config.board_id];
      if (!credentials) {
        throw new CliError(
          `This directory is connected to board "${existing.config.board_name}", but this machine has no keys for it.`,
          { hint: "Join with `agentbridge init --join <invite link>`." },
        );
      }
      const board = { id: existing.config.board_id, name: existing.config.board_name };
      return addToBoard(context, board, credentials, existing.dir);
    }

    const server = (
      join?.server ??
      stringValue(values, "server") ??
      (io.env.AGENTBRIDGE_SERVER
        ? io.env.AGENTBRIDGE_SERVER
        : await valueOrAsk(context, "server", "Server address", DEFAULT_SERVER, {
            required: false,
          }))
    ).replace(/\/+$/, "");

    // An invite to a board this machine is already on: add the agent instead of joining again
    // (which would register the person a second time as "alice-2").
    if (join) {
      let board: { id: string; name: string };
      try {
        board = (await new ApiClient(server, undefined, io.fetch).inviteInfo(join.token)).board;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) throw invalidInvite();
        throw error;
      }
      if (existing && !force && existing.config.board_id !== board.id) {
        throw alreadyConnected(existing.config.board_name, existing.path);
      }
      const credentials = stored[board.id];
      if (credentials && !force) {
        return addToBoard(context, board, credentials, existing?.dir ?? io.cwd);
      }
    } else if (existing && !force) {
      throw alreadyConnected(existing.config.board_name, existing.path);
    }

    // Names: given with flags, asked in a terminal, or picked automatically (an agent runs this).
    const ownerGiven = stringValue(values, "owner") !== undefined;
    const suggested =
      suggestOwner(await gitUserName(io.cwd, io.env)) ??
      suggestOwner(io.env.USER ?? io.env.USERNAME);
    const owner = await valueOrAsk(
      context,
      "owner",
      "Your name (lowercase letters, digits and -)",
      suggested,
      { required: false },
    );
    if (parseHandle(owner)?.kind !== "human") {
      throw new UsageError(
        `"${owner}" is not a valid name.`,
        'Use lowercase letters, digits and "-", at most 32 characters, and not "all" or "human".',
      );
    }

    const agentName = await askAgentName(context, owner);

    const client = new ApiClient(server, undefined, io.fetch);
    let inviteUrl: string | undefined;
    let feedUrl: string | undefined;
    let joinToken: string;

    if (join) {
      joinToken = join.token;
    } else {
      const name = await valueOrAsk(context, "name", "Board name", basename(io.cwd), {
        required: false,
      });
      const created = await client.createBoard(name);
      joinToken = created.join_token;
      inviteUrl = created.join_url;
      feedUrl = created.feed_url;
    }

    // A name picked automatically that is taken gets a number (alice-2); a name given with
    // --owner is the person's choice, so a clash is reported instead.
    let joined: Awaited<ReturnType<ApiClient["join"]>> | undefined;
    let ownerUsed = owner;
    for (let attempt = 1; joined === undefined; attempt++) {
      ownerUsed = attempt === 1 ? owner : withSuffix(owner, attempt);
      const members = [
        { handle: ownerUsed, kind: "human" as const },
        ...(agentName === undefined
          ? []
          : [{ handle: `${ownerUsed}/${agentName}`, kind: "agent" as const }]),
      ];
      try {
        joined = await client.join({ join_token: joinToken, owner: ownerUsed, members });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) throw invalidInvite();
        if (error instanceof ApiError && error.status === 409) {
          if (!ownerGiven && attempt < 9) continue;
          throw new CliError(
            `Someone named "${ownerUsed}" (or that agent) is already on this board.`,
            { hint: "Pick another --owner or --agent name." },
          );
        }
        throw error;
      }
    }
    const renamed = ownerUsed !== owner;

    const boardId = joined.board.id;
    const boardName = joined.board.name;
    const human = joined.members.find((m) => m.kind === "human");
    const agent = joined.members.find((m) => m.kind === "agent");
    if (!human) throw new CliError("The server did not return your account.");

    const humanIdentity: Identity = { handle: human.handle, api_key: human.api_key };
    const tool = agentName === undefined ? undefined : toolFor(io.env, agentName);
    await saveBoardCredentials(io.env, boardId, {
      server,
      owner: ownerUsed,
      human: humanIdentity,
      agents:
        agent && agentName
          ? {
              [agentName]: {
                handle: agent.handle,
                api_key: agent.api_key,
                ...(tool ? { tool } : {}),
              },
            }
          : {},
    });
    const path = await writeRepoConfig(existing?.dir ?? io.cwd, {
      server,
      board_id: boardId,
      board_name: boardName,
    });

    // Someone who joined gets a feed link of their own (the creator got one with the board).
    if (feedUrl === undefined) {
      feedUrl = await new ApiClient(server, human.api_key, io.fetch)
        .createToken({ scope: "read", label: `feed for ${human.handle}` })
        .then((token) => token.url)
        .catch(() => undefined);
    }
    const invitation = inviteUrl ? inviteMessage(boardName, inviteUrl) : undefined;

    const hooks = await claudeCodeHooks(context, agent !== undefined, existing?.dir ?? io.cwd);

    if (context.json) {
      io.out(
        `${JSON.stringify({
          board: joined.board,
          server,
          human: human.handle,
          agent: agent?.handle ?? null,
          agents: agent ? [agent.handle] : [],
          already_member: false,
          agent_added: agent !== undefined,
          renamed,
          config: path,
          invite_url: inviteUrl ?? null,
          invite_message: invitation ?? null,
          feed_url: feedUrl ?? null,
          claude_code: hooks.state,
        })}\n`,
      );
      return EXIT.ok;
    }

    io.out(`Connected to board "${boardName}" on ${server}\n`);
    io.out(`You are ${human.handle}${agent ? ` and your agent is ${agent.handle}` : ""}.\n`);
    if (renamed) {
      io.out(`("${owner}" was already taken on this board, so you are "${ownerUsed}".)\n`);
    }
    io.out(`Wrote ${path} (no secrets; commit it so teammates use the same board).\n`);
    io.out("Your keys are stored outside the repository, readable only by you.\n");
    if (invitation && inviteUrl) {
      io.out("\nSend this to your teammates; they paste it into their coding agent:\n");
      io.out(`  ${invitation}\n`);
      io.out(`(Without an agent: agentbridge init --join ${inviteUrl})\n`);
    }
    if (feedUrl) {
      io.out(`\nWatch the board in your browser (read-only):\n  ${feedUrl}\n`);
    } else {
      io.out("\nWatch the board in your browser: agentbridge feed\n");
    }
    io.out(claudeCodeText(hooks.state, hooks.text));
    return EXIT.ok;
  },
};
