import type { ChildProcess } from "node:child_process";

import {
  EVE_BASE_URL_ENV,
  resolveSharedDevelopmentServer,
} from "#internal/nitro/host/resolve-shared-development-server.js";

export { EVE_BASE_URL_ENV };

export interface EveProcessHandle {
  readonly origin: string;
  readonly process?: ChildProcess;
}

interface EveDevelopmentServerHandle extends EveProcessHandle {
  readonly close?: () => Promise<void>;
}

const DEVELOPMENT_SERVER_TIMEOUT_MS = 30_000;

/** Resolves the root-scoped Eve development server used by Nuxt. */
export function resolveSharedEveDevServer(appRoot: string): Promise<EveDevelopmentServerHandle> {
  return resolveSharedDevelopmentServer({
    appRoot,
    timeoutMs: DEVELOPMENT_SERVER_TIMEOUT_MS,
  });
}
