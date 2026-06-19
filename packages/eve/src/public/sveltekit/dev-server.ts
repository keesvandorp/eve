import {
  EVE_BASE_URL_ENV,
  resolveSharedDevelopmentServer,
  type SharedDevelopmentServerHandle,
} from "#internal/nitro/host/resolve-shared-development-server.js";

export { EVE_BASE_URL_ENV };
export type EveProcessHandle = SharedDevelopmentServerHandle;

const DEVELOPMENT_SERVER_TIMEOUT_MS = 30_000;

/** Resolves the root-scoped Eve development server used by SvelteKit. */
export function resolveSharedEveDevServer(appRoot: string): Promise<EveProcessHandle> {
  return resolveSharedDevelopmentServer({
    appRoot,
    timeoutMs: DEVELOPMENT_SERVER_TIMEOUT_MS,
  });
}
