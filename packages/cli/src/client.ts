import type { CreateTokenRequest, components, MembersResponse } from "@agentbridge/protocol";
import { CliError, UsageError } from "./io.ts";

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

const q = encodeURIComponent;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Sending or fetching a file of a few megabytes on a slow connection. */
const TRANSFER_TIMEOUT_MS = 120_000;

/** What the server answers on a path it does not know. */
const NO_ENDPOINT = "no such endpoint";

const LOCAL_ADDRESS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const SERVER_HINT = "It should look like https://ab.froti.dev or http://localhost:8080.";

/**
 * Turns what a person typed as the server address into the form the client uses:
 * `ab.froti.dev/` -> `https://ab.froti.dev`, `localhost:8080` -> `http://localhost:8080`.
 * `from` names where the value came from (an environment variable) for the error message.
 */
export function normalizeServer(input: string, from?: string): string {
  const value = input.trim();
  const source = from === undefined ? "" : ` (from ${from})`;
  if (value === "") throw new UsageError(`No server address given${source}.`, SERVER_HINT);
  const notAnAddress = () =>
    new UsageError(`"${value}" is not a server address${source}.`, SERVER_HINT);

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const scheme = LOCAL_ADDRESS.test(value) ? "http" : "https";
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `${scheme}://${value}`);
  } catch {
    throw notAnAddress();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    /\s/.test(value)
  ) {
    throw notAnAddress();
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

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

  /** One call to the server. Failing to reach it becomes a message for the person. */
  private async call(
    method: string,
    path: string,
    options: {
      body?: unknown;
      /** Sent as it is, instead of a JSON body. */
      bytes?: Uint8Array;
      query?: Record<string, string | number | boolean | string[] | undefined>;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const url = new URL(this.server + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (options.bytes !== undefined) headers["content-type"] = "application/octet-stream";
    else if (options.body !== undefined) headers["content-type"] = "application/json";

    let payload: string | Uint8Array | null = null;
    if (options.bytes !== undefined) payload = options.bytes;
    else if (options.body !== undefined) payload = JSON.stringify(options.body);

    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
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
  }

  private async request<T>(
    method: string,
    path: string,
    options: Parameters<ApiClient["call"]>[2] = {},
  ): Promise<{ status: number; data: T }> {
    const response = await this.call(method, path, options);

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

  async createToken(body: CreateTokenRequest): Promise<Schemas["TokenCreated"]> {
    return (await this.request<Schemas["TokenCreated"]>("POST", "/v1/tokens", { body })).data;
  }

  // ---- members ----

  async me(): Promise<Schemas["Me"]> {
    return (await this.request<Schemas["Me"]>("GET", "/v1/me")).data;
  }

  async members(options: { pending?: boolean } = {}): Promise<MembersResponse> {
    const path = options.pending ? "/v1/members?pending=true" : "/v1/members";
    return (await this.request<MembersResponse>("GET", path)).data;
  }

  // ---- the board's owner: who is on the board, links, the security log ----

  async accept(person: string): Promise<void> {
    await this.owned(() => this.request("POST", `/v1/members/${q(person)}/accept`));
  }

  async decline(person: string): Promise<void> {
    await this.owned(() => this.request("POST", `/v1/members/${q(person)}/decline`));
  }

  async removeMember(handle: string): Promise<void> {
    // An agent's handle has a slash; the server reads the rest of the path as the handle.
    const path = handle.split("/").map(q).join("/");
    await this.owned(() => this.request("DELETE", `/v1/members/${path}`));
  }

  async leave(): Promise<void> {
    await this.owned(() => this.request("POST", "/v1/me/leave"));
  }

  async handOver(handle: string): Promise<void> {
    await this.owned(() => this.request("PUT", "/v1/board/owner", { body: { handle } }));
  }

  async tokens(): Promise<Schemas["TokensResponse"]> {
    return this.owned(
      async () => (await this.request<Schemas["TokensResponse"]>("GET", "/v1/tokens")).data,
    );
  }

  async revokeToken(id: string): Promise<void> {
    await this.owned(() => this.request("DELETE", `/v1/tokens/${q(id)}`));
  }

  async audit(limit?: number): Promise<Schemas["SecurityEventsResponse"]> {
    const path = limit === undefined ? "/v1/audit" : `/v1/audit?limit=${limit}`;
    return this.owned(
      async () => (await this.request<Schemas["SecurityEventsResponse"]>("GET", path)).data,
    );
  }

  /** A server older than board owners answers these paths with "no such endpoint". */
  private async owned<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.message === NO_ENDPOINT) {
        throw new ApiError(
          404,
          "not_found",
          "This board's server has no board owners yet: it is older than this agentbridge.",
        );
      }
      throw error;
    }
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

  /** One message by its number, or null when the board has no such message. */
  async message(seq: number): Promise<Schemas["Message"] | null> {
    const page = await this.history({ after: seq - 1, limit: 1 });
    const found = page.messages[0];
    return found?.seq === seq ? found : null;
  }

  // ---- shared documents ----

  async documents(): Promise<Schemas["DocumentsResponse"]> {
    return (await this.request<Schemas["DocumentsResponse"]>("GET", "/v1/docs")).data;
  }

  /** One document, or null when the board has none by that name (or no such version). */
  async document(name: string, version?: number): Promise<Schemas["Document"] | null> {
    try {
      return (await this.request<Schemas["Document"]>("GET", docPath(name), { query: { version } }))
        .data;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async writeDocument(
    name: string,
    body: Schemas["WriteDocumentRequest"],
  ): Promise<Schemas["DocumentInfo"]> {
    return (await this.request<Schemas["DocumentInfo"]>("PUT", docPath(name), { body })).data;
  }

  async deleteDocument(name: string): Promise<void> {
    await this.request("DELETE", docPath(name));
  }

  // ---- zones: the parts of the project that agents have taken ----

  async zones(): Promise<Schemas["ZonesResponse"]> {
    return (await this.request<Schemas["ZonesResponse"]>("GET", "/v1/zones")).data;
  }

  async claimZone(body: Schemas["ClaimZoneRequest"]): Promise<Schemas["ClaimResult"]> {
    return (await this.request<Schemas["ClaimResult"]>("POST", "/v1/zones", { body })).data;
  }

  async releaseZone(id: string): Promise<void> {
    await this.request("DELETE", `/v1/zones/${encodeURIComponent(id)}`);
  }

  /** Which of these files (repository-relative) sit inside a zone of somebody else. */
  async checkZones(paths: string[]): Promise<Schemas["ZoneCheck"]> {
    return (
      await this.request<Schemas["ZoneCheck"]>("GET", "/v1/zones/check", { query: { path: paths } })
    ).data;
  }

  // ---- tasks: what the board works on, and which agents work on each ----

  async tasks(state?: Schemas["Task"]["state"]): Promise<Schemas["TasksResponse"]> {
    return this.withTasks(
      async () =>
        (await this.request<Schemas["TasksResponse"]>("GET", "/v1/tasks", { query: { state } }))
          .data,
    );
  }

  async addTask(body: Schemas["AddTaskRequest"]): Promise<Schemas["Task"]> {
    return this.withTasks(
      async () => (await this.request<Schemas["Task"]>("POST", "/v1/tasks", { body })).data,
    );
  }

  /** Take, leave or finish task number `number`. */
  async taskAction(number: number, action: "take" | "leave" | "done"): Promise<Schemas["Task"]> {
    return this.withTasks(
      async () =>
        (await this.request<Schemas["Task"]>("POST", `/v1/tasks/${number}/${action}`)).data,
    );
  }

  // ---- files: sent from one member to others, kept by the server for a while ----

  /** Sends a file to members of the board. It travels with a message addressed to them. */
  async sendFile(
    content: Uint8Array,
    query: { name: string; to: string[]; reply_to?: number; note?: string },
  ): Promise<Schemas["FileSent"]> {
    return this.supported("files", async () => {
      const sent = await this.request<Schemas["FileSent"]>("POST", "/v1/files", {
        bytes: content,
        query,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      return sent.data;
    });
  }

  /** The files sent to me or by me, newest first. */
  async files(): Promise<Schemas["FilesResponse"]> {
    return this.supported(
      "files",
      async () => (await this.request<Schemas["FilesResponse"]>("GET", "/v1/files")).data,
    );
  }

  async file(number: number): Promise<Schemas["FileInfo"]> {
    return this.supported(
      "files",
      async () => (await this.request<Schemas["FileInfo"]>("GET", `/v1/files/${number}`)).data,
    );
  }

  /** The content of a file, with the checksum the server keeps for it. */
  async fileContent(number: number): Promise<{ content: Uint8Array; sha256: string | null }> {
    return this.supported("files", async () => {
      const response = await this.call("GET", `/v1/files/${number}/content`, {
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      if (!response.ok) {
        let error: { code?: string; message?: string } | undefined;
        try {
          error = ((await response.json()) as { error?: typeof error }).error;
        } catch {
          // Not our server's error format: the status is all there is.
        }
        throw new ApiError(
          response.status,
          error?.code ?? "unknown",
          error?.message ?? `HTTP ${response.status}`,
        );
      }
      return {
        content: new Uint8Array(await response.arrayBuffer()),
        sha256: response.headers.get("x-file-sha256"),
      };
    });
  }

  /** Takes a file back before its time is up (its sender only). */
  async removeFile(number: number): Promise<void> {
    await this.supported("files", () => this.request("DELETE", `/v1/files/${number}`));
  }

  private withTasks<T>(call: () => Promise<T>): Promise<T> {
    return this.supported("tasks", call);
  }

  /** A server older than this client lacks newer features: say so instead of "no such endpoint". */
  private async supported<T>(what: "tasks" | "files", call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.message === NO_ENDPOINT) {
        throw new ApiError(
          404,
          "not_supported",
          `This board's server has no ${what} yet: it is older than your agentbridge. ` +
            "Whoever runs the server has to update it.",
        );
      }
      throw error;
    }
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

/** The server's rule for document names, checked first so "../x" never becomes another URL. */
const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function checkDocumentName(name: string): string {
  if (name.length > 120 || !DOC_NAME.test(name)) {
    throw new UsageError(
      `"${name}" is not a document name.`,
      'Use letters, digits, ".", "_", "-" and "/" between parts, like "plan.md" or "api/users.md".',
    );
  }
  return name;
}

/** "/v1/docs/api/users.md", each part of the name encoded on its own. */
function docPath(name: string): string {
  return `/v1/docs/${checkDocumentName(name).split("/").map(encodeURIComponent).join("/")}`;
}
