import type { components } from "@agentbridge/protocol";
import { CliError } from "./io.ts";

type Schemas = components["schemas"];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** A small typed client for the board server. Types come from the server's OpenAPI description. */
export class ApiClient {
  readonly server: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(
    server: string,
    apiKey?: string,
    fetchImpl: typeof fetch = fetch,
    defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.server = server.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ status: number; data: T }> {
    const url = new URL(this.server + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new CliError(
        timedOut
          ? `The server at ${this.server} did not answer in time.`
          : `Cannot reach the server at ${this.server}.`,
        { hint: "Check the address and your connection." },
      );
    }

    const text = response.status === 204 ? "" : await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new CliError(`The server at ${this.server} sent an unexpected response.`, {
          hint: "Is the address correct?",
        });
      }
    }

    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "unknown",
        error?.message ?? `HTTP ${response.status}`,
      );
    }
    return { status: response.status, data: data as T };
  }

  // ---- boards and tokens (no member key needed for the first two) ----

  async createBoard(name: string): Promise<Schemas["BoardCreated"]> {
    return (await this.request<Schemas["BoardCreated"]>("POST", "/v1/boards", { body: { name } }))
      .data;
  }

  async join(body: Schemas["JoinBoardRequest"]): Promise<Schemas["JoinResult"]> {
    return (await this.request<Schemas["JoinResult"]>("POST", "/v1/boards/join", { body })).data;
  }

  async inviteInfo(token: string): Promise<Schemas["InviteInfo"]> {
    return (await this.request<Schemas["InviteInfo"]>("GET", "/v1/invite", { query: { token } }))
      .data;
  }

  /** Registers another agent of the calling person (needs the person's own key). */
  async addAgent(name: string): Promise<Schemas["JoinedMember"]> {
    return (await this.request<Schemas["JoinedMember"]>("POST", "/v1/agents", { body: { name } }))
      .data;
  }

  async createToken(body: Schemas["CreateTokenRequest"]): Promise<Schemas["TokenCreated"]> {
    return (await this.request<Schemas["TokenCreated"]>("POST", "/v1/tokens", { body })).data;
  }

  // ---- members ----

  async me(): Promise<Schemas["Me"]> {
    return (await this.request<Schemas["Me"]>("GET", "/v1/me")).data;
  }

  async members(): Promise<Schemas["MembersResponse"]> {
    return (await this.request<Schemas["MembersResponse"]>("GET", "/v1/members")).data;
  }

  async setStatus(text: string | null): Promise<void> {
    await this.request("PUT", "/v1/me/status", { body: { text } });
  }

  // ---- messages and inbox ----

  async post(body: Schemas["PostMessageRequest"]): Promise<Schemas["PostMessageResponse"]> {
    return (await this.request<Schemas["PostMessageResponse"]>("POST", "/v1/messages", { body }))
      .data;
  }

  async history(query: { after?: number; limit?: number }): Promise<Schemas["MessagesPage"]> {
    return (await this.request<Schemas["MessagesPage"]>("GET", "/v1/messages", { query })).data;
  }

  async inbox(query: { ack: boolean; limit?: number }): Promise<Schemas["InboxResult"]> {
    return (await this.request<Schemas["InboxResult"]>("GET", "/v1/inbox", { query })).data;
  }

  /** Marks everything up to message number `upTo` as read. */
  async ack(upTo: number): Promise<void> {
    await this.request("POST", "/v1/inbox/ack", { body: { up_to: upTo } });
  }

  /** Long-poll. Resolves to null when nothing arrived within `timeoutSeconds`. */
  async wait(timeoutSeconds: number, limit?: number): Promise<Schemas["InboxResult"] | null> {
    const { status, data } = await this.request<Schemas["InboxResult"]>("GET", "/v1/inbox/wait", {
      query: { timeout: timeoutSeconds, limit },
      timeoutMs: (timeoutSeconds + 15) * 1000,
    });
    return status === 204 ? null : data;
  }
}
