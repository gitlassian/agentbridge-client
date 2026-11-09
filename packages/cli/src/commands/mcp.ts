import { VERSION } from "../cli.ts";
import type { Command } from "../command.ts";
import { EXIT } from "../io.ts";
import { McpServer } from "../mcp/server.ts";
import { createTools, INSTRUCTIONS } from "../mcp/tools.ts";

/** After the client closes the input, requests still running get this long to finish. */
const SHUTDOWN_GRACE_MS = 3000;

export const mcp: Command = {
  name: "mcp",
  summary: "Run an MCP server so agents can use the board as tools",
  usage:
    "agentbridge mcp [--agent NAME]   (speaks the Model Context Protocol on stdin/stdout; started by\n" +
    "the agent, not by hand; --agent picks which of your agents it acts as, e.g. --agent codex)",
  options: {},
  async run({ io, agent }) {
    const server = new McpServer(
      { name: "agentbridge", version: VERSION },
      INSTRUCTIONS,
      createTools(io, agent),
      io.err,
    );

    // Requests run side by side: a `wait` that blocks for 30 seconds must not hold up a `post`.
    const running = new Set<Promise<void>>();
    for await (const line of io.readLines()) {
      if (line.trim() === "") continue;
      const task = server.handle(line).then((reply) => {
        if (reply !== undefined) io.out(`${reply}\n`);
      });
      running.add(task);
      void task.finally(() => running.delete(task));
    }

    const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    await Promise.race([Promise.allSettled(running), grace]);
    return EXIT.ok;
  },
};
