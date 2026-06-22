import { EVE_HEALTH_ROUTE_PATH, EVE_INFO_ROUTE_PATH } from "#protocol/routes.js";
import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { ClientError } from "#client/client-error.js";
import { ClientSession } from "#client/session.js";
import { createInitialSessionState } from "#client/session-utils.js";
import { createClientUrl } from "#client/url.js";
import type {
  AgentInfoResult,
  ClientAuth,
  ClientOptions,
  ClientRedirectPolicy,
  HeadersValue,
  HealthResult,
  SessionState,
  TokenValue,
} from "#client/types.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";

/**
 * HTTP client for talking to a deployed eve agent.
 *
 * A single client is bound to one host and auth configuration. It can create
 * many concurrent {@link ClientSession | sessions}, each tracking their own
 * conversation state independently.
 */
export class Client {
  readonly #auth: ClientAuth | undefined;
  readonly #headers: HeadersValue | undefined;
  readonly #host: string;
  readonly #maxReconnectAttempts: number;
  readonly #preserveCompletedSessions: boolean;
  readonly #redirect: ClientRedirectPolicy | undefined;

  constructor(options: ClientOptions) {
    this.#host = options.host;
    this.#auth = options.auth;
    this.#headers = options.headers;
    this.#maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
    this.#preserveCompletedSessions = options.preserveCompletedSessions ?? false;
    this.#redirect = options.redirect;
  }

  /**
   * Checks the health of the eve agent server.
   *
   * @throws {ClientError} If the server returns a non-successful status.
   */
  async health(): Promise<HealthResult> {
    const url = createClientUrl(this.#host, EVE_HEALTH_ROUTE_PATH);
    const headers = await this.#resolveHeaders();
    const response = await fetch(url, withRedirectPolicy({ headers }, this.#redirect));

    if (!response.ok) {
      const body = await response.text();
      throw new ClientError(response.status, body);
    }

    return (await response.json()) as HealthResult;
  }

  /**
   * Fetches the agent inspection payload from `GET /eve/v1/info`.
   *
   * The dev TUI uses it to render its startup header. Remote deployments
   * require whatever auth the info route accepts, which defaults to Vercel
   * OIDC outside local development.
   *
   * @throws {ClientError} If the server returns a non-successful status.
   */
  async info(options: { readonly signal?: AbortSignal } = {}): Promise<AgentInfoResult> {
    const request: RequestInit = {};
    if (options.signal !== undefined) request.signal = options.signal;
    const response = await this.fetch(EVE_INFO_ROUTE_PATH, request);

    if (!response.ok) {
      const body = await response.text();
      throw new ClientError(response.status, body);
    }

    const info: unknown = await response.json();
    if (!isAgentInfoResult(info)) {
      throw new SyntaxError(
        "The server returned an unrecognized response from the Eve agent info route.",
      );
    }

    return info;
  }

  /**
   * Performs an authenticated fetch against a path on this eve target.
   *
   * This is the raw escape hatch for framework-owned routes (for example
   * channel ingress or dev-only schedule dispatch) while preserving the same
   * auth/header cascade used by {@link health}, {@link info}, and sessions.
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = createClientUrl(this.#host, path);
    const headers = await raceWithAbort(
      this.#resolveHeaders(headersInitToRecord(init.headers)),
      init.signal ?? undefined,
    );
    return await fetch(url, withRedirectPolicy({ ...init, headers }, this.#redirect));
  }

  /**
   * Creates a {@link ClientSession} handle for one conversation.
   *
   * - **No arguments**: starts a fresh conversation. The first
   *   `session.send()` call creates the run on the server.
   * - **{@link SessionState}**: resumes a previously serialized session.
   * - **string**: shorthand for resuming with a continuation token alone.
   */
  session(state?: SessionState | string): ClientSession {
    let resolved: SessionState;

    if (typeof state === "string") {
      resolved = { continuationToken: state, streamIndex: 0 };
    } else if (state) {
      resolved = state;
    } else {
      resolved = createInitialSessionState();
    }

    return new ClientSession(
      {
        host: this.#host,
        maxReconnectAttempts: this.#maxReconnectAttempts,
        preserveCompletedSessions: this.#preserveCompletedSessions,
        redirect: this.#redirect,
        resolveHeaders: (perRequest, signal) =>
          raceWithAbort(this.#resolveHeaders(perRequest), signal),
      },
      resolved,
    );
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async #resolveHeaders(perRequest?: Readonly<Record<string, string>>): Promise<Headers> {
    const headers = new Headers();
    const baseHeaders = await resolveHeadersValue(this.#headers);

    for (const [key, value] of Object.entries(baseHeaders)) {
      headers.set(key, value);
    }

    if (perRequest) {
      for (const [key, value] of Object.entries(perRequest)) {
        headers.set(key, value);
      }
    }

    await this.#applyAuth(headers);

    return headers;
  }

  async #applyAuth(headers: Headers): Promise<void> {
    const auth = this.#auth;
    if (!auth) return;

    if ("vercelOidc" in auth) {
      // One credential, two headers: the bearer the route reads and the
      // trusted-OIDC header Vercel Deployment Protection accepts. Resolved
      // once; the client-side mirror of the server `vercelOidc()` channel.
      const token = (await resolveTokenValue(auth.vercelOidc.token)).trim();
      if (token.length === 0) return;
      headers.set("authorization", `Bearer ${token}`);
      headers.set(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER, token);
      return;
    }

    if ("bearer" in auth) {
      // Skip the header entirely on an empty token rather than emitting a
      // malformed `Bearer ` value the server has to reject. The dev client's
      // OIDC resolver returns "" when no token is available locally; the
      // request then goes out unauthenticated and the framework's
      // `vercelOidc()` channel handler returns a clean 401.
      const token = (await resolveTokenValue(auth.bearer)).trim();
      if (token.length === 0) return;
      headers.set("authorization", `Bearer ${token}`);
      return;
    }

    if ("basic" in auth) {
      const password = await resolveTokenValue(auth.basic.password);
      headers.set(
        "authorization",
        `Basic ${encodeBasicCredentials(auth.basic.username, password)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAgentInfoResult(value: unknown): value is AgentInfoResult {
  return AgentInfoResultSchema.safeParse(value).success;
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolveTokenValue(value: TokenValue): Promise<string> {
  return typeof value === "function" ? value() : value;
}

async function resolveHeadersValue(
  value: HeadersValue | undefined,
): Promise<Readonly<Record<string, string>>> {
  if (value === undefined) {
    return {};
  }

  return typeof value === "function" ? await value() : value;
}

function headersInitToRecord(
  headers: RequestInit["headers"] | undefined,
): Readonly<Record<string, string>> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function withRedirectPolicy(
  init: RequestInit,
  redirect: ClientRedirectPolicy | undefined,
): RequestInit {
  return redirect === undefined ? init : { ...init, redirect };
}

/**
 * Encodes a username:password pair as a base64 Basic auth credential.
 * Uses `TextEncoder` for correct UTF-8 handling across all runtimes.
 */
function encodeBasicCredentials(username: string, password: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`${username}:${password}`);
  const binaryString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
  return btoa(binaryString);
}
