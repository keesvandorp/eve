import { EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";

const DEFAULT_EVE_SERVER_HEALTH_TIMEOUT_MS = 1_000;

/** Returns whether an Eve server answers its health route successfully. */
export async function isEveServerHealthy(
  serverUrl: string,
  timeoutMs: number = DEFAULT_EVE_SERVER_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const healthUrl = new URL(EVE_HEALTH_ROUTE_PATH, serverUrl).toString();
    const response = await fetch(healthUrl, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
