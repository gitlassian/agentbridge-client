/**
 * A small Model Context Protocol server: JSON-RPC 2.0, one JSON message per line.
 *
 * Only what agents need is implemented (initialize, ping, tools/list, tools/call), which keeps
 * the CLI free of runtime dependencies. This class is pure: it turns one incoming line into one
 * outgoing line, so it can be tested without any process or stream.
 */

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  /** Runs the tool and returns the text for the model. Throws to report a failure. */
  call: (args: Record<string, unknown>) => Promise<string>;
}

export interface ServerInfo {
  name: string;
  version: string;
}

/** Versions of the protocol whose basic tool calls we handle. */
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type Id = string | number | null;

function respond(id: Id, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function fail(id: Id, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class McpServer {
  private readonly tools: Map<string, Tool>;
  private readonly info: ServerInfo;
  private readonly instructions: string;
  private readonly log: (text: string) => void;

  constructor(
    info: ServerInfo,
    instructions: string,
    tools: Tool[],
    /** Where unexpected failures are reported (never to standard output). */
    log: (text: string) => void = () => undefined,
  ) {
    this.info = info;
    this.instructions = instructions;
    this.log = log;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Handles one incoming line. Resolves to the line to send back, or undefined for none. */
  async handle(line: string): Promise<string | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return fail(null, ERROR.parse, "Parse error: the message is not valid JSON");
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      return fail(null, ERROR.invalidRequest, "Invalid request: expected a JSON-RPC 2.0 object");
    }
    // A response to something we sent: we send no requests, so there is nothing to match.
    if (typeof message.method !== "string") return undefined;

    const isNotification = !("id" in message);
    const id = isNotification ? null : (message.id as Id);

    try {
      const result = await this.dispatch(message.method, message.params);
      if (isNotification) return undefined;
      return result === undefined
        ? fail(id, ERROR.methodNotFound, `Method not found: ${message.method}`)
        : respond(id, result);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return isNotification ? undefined : fail(id, error.code, error.message);
      }
      this.log(`mcp: unexpected error in ${message.method}: ${String(error)}\n`);
      return isNotification ? undefined : fail(id, ERROR.internal, "Internal error");
    }
  }

  /** Resolves to undefined for a method we do not know. */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = isObject(params) ? params.protocolVersion : undefined;
        const version =
          typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked)
            ? asked
            : (SUPPORTED_VERSIONS[0] as string);
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          instructions: this.instructions,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
          })),
        };
      case "tools/call":
        return await this.callTool(params);
      default:
        // Notifications (initialized, cancelled, ...) need no work; unknown requests are
        // reported by the caller.
        return method.startsWith("notifications/") ? {} : undefined;
    }
  }

  private async callTool(params: unknown): Promise<unknown> {
    if (!isObject(params) || typeof params.name !== "string") {
      throw new ProtocolError(ERROR.invalidParams, "tools/call needs a tool name");
    }
    const tool = this.tools.get(params.name);
    if (!tool) throw new ProtocolError(ERROR.invalidParams, `Unknown tool: ${params.name}`);

    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) {
      throw new ProtocolError(ERROR.invalidParams, "arguments must be an object");
    }

    // A failing tool is a result the model can read and react to, not a protocol error.
    try {
      return { content: [{ type: "text", text: await tool.call(args) }] };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text }], isError: true };
    }
  }
}
