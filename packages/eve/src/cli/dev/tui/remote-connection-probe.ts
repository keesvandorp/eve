import { ClientError } from "#client/index.js";
import { isVercelAuthChallenge } from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

import type {
  RemoteConnectionControllerOptions,
  RemoteConnectionState,
} from "./remote-connection-types.js";

export type RemoteProbeResult = Extract<
  RemoteConnectionState,
  { state: "ready" | "auth-required" | "unavailable" }
>;

const REMOTE_PROBE_TIMEOUT_MS = 10_000;

function isEveOidcChallenge(error: unknown): boolean {
  if (!(error instanceof ClientError) || error.status !== 401) return false;

  try {
    const body: unknown = JSON.parse(error.body);
    return (
      isObject(body) &&
      body.ok === false &&
      body.code === "unauthorized" &&
      body.error === "Authorization is required for this route."
    );
  } catch {
    return false;
  }
}

export function classifyRemoteError(error: unknown): RemoteProbeResult {
  if (isVercelAuthChallenge(error)) {
    return {
      state: "auth-required",
      challenge: { kind: "vercel-deployment-protection" },
    };
  }
  if (isEveOidcChallenge(error)) {
    return {
      state: "auth-required",
      challenge: { kind: "eve-oidc" },
    };
  }
  if (error instanceof ClientError) {
    return { state: "unavailable", failure: { message: error.message } };
  }
  return {
    state: "unavailable",
    failure: { message: toErrorMessage(error) },
  };
}

export async function probeRemoteInfo(input: {
  readonly client: RemoteConnectionControllerOptions["client"];
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<RemoteProbeResult> {
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeoutMs ?? REMOTE_PROBE_TIMEOUT_MS),
  ]);
  try {
    return { state: "ready", info: await input.client.info({ signal }) };
  } catch (error) {
    return classifyRemoteError(error);
  }
}
