import { httpServerUrlSchema } from "#shared/network-address.js";

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

/** Returns whether `url` targets a recognized local development host. */
export function isLocalEveServerUrl(url: URL): boolean {
  return LOCAL_HOSTNAMES.has(url.hostname);
}

/** Whether `serverUrl` is a local dev host. Invalid URLs count as remote. */
export function isLocalDevelopmentServerUrl(serverUrl: string): boolean {
  const parsed = httpServerUrlSchema.safeParse(serverUrl);
  return parsed.success && isLocalEveServerUrl(new URL(parsed.data));
}
