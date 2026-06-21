import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  EVE_BASE_URL_ENV,
  resolveSharedDevelopmentServer,
} from "#internal/nitro/host/resolve-shared-development-server.js";
import { isLoopbackHostname } from "#shared/network-address.js";

const DEFAULT_SERVER_READY_TIMEOUT_MS = 180_000;
const DEVELOPMENT_SERVER_TIMEOUT_MS = 180_000;
const SERVER_URL_CANDIDATE_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const NEXT_PHASE_PRODUCTION_BUILD = "phase-production-build";

interface EveNextGlobalState {
  readonly servers: Map<string, Promise<EveProcessHandle>>;
}

interface EveProcessHandle {
  readonly origin: string;
  readonly process?: ChildProcess;
}

const globalStateSymbol = Symbol.for("eve.next.state");

function getGlobalState(): EveNextGlobalState {
  const globalWithState = globalThis as typeof globalThis & {
    [globalStateSymbol]?: EveNextGlobalState;
  };

  globalWithState[globalStateSymbol] ??= {
    servers: new Map(),
  };

  return globalWithState[globalStateSymbol];
}

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

function readEveBaseUrlEnvironment(): string | undefined {
  const configuredUrl = process.env[EVE_BASE_URL_ENV];

  if (configuredUrl === undefined || configuredUrl.trim().length === 0) {
    return undefined;
  }

  return normalizeOrigin(configuredUrl);
}

function parseLocalServerOrigin(urlText: string): string | undefined {
  const url = URL.parse(urlText);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopbackHostname(url.hostname) ||
    url.port.length === 0
  ) {
    return undefined;
  }

  return url.origin;
}

function findLocalServerOrigin(output: string): string | undefined {
  for (const match of output.matchAll(SERVER_URL_CANDIDATE_PATTERN)) {
    const origin = parseLocalServerOrigin(match[0]);
    if (origin !== undefined) {
      return origin;
    }
  }

  return undefined;
}

function startServerProcess(input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}): Promise<EveProcessHandle> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = input.timeoutMs ?? DEFAULT_SERVER_READY_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for the server URL.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", handleError);
      child.off("exit", handleEarlyExit);
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Server process exited before printing its URL (code ${String(code)}, signal ${String(signal)}).`,
        ),
      );
    };
    const handleOutput = (chunk: Buffer) => {
      const origin = findLocalServerOrigin(chunk.toString("utf8"));
      if (origin === undefined) {
        return;
      }

      cleanup();
      resolvePromise({ origin, process: child });
    };
    const handleStdout = (chunk: Buffer) => {
      process.stdout.write(chunk);
      handleOutput(chunk);
    };
    const handleStderr = (chunk: Buffer) => {
      process.stderr.write(chunk);
      handleOutput(chunk);
    };

    child.once("error", handleError);
    child.once("exit", handleEarlyExit);
    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);
  });
}

function installProcessShutdown(handle: EveProcessHandle): EveProcessHandle {
  const childProcess = handle.process;

  if (childProcess === undefined) {
    return handle;
  }

  const close = () => {
    if (!childProcess.killed) {
      childProcess.kill();
    }
  };

  process.once("beforeExit", close);
  process.once("exit", close);
  return handle;
}

function startEveProductionServer(input: {
  readonly appRoot: string;
  readonly origin: string;
}): Promise<EveProcessHandle> | undefined {
  const parsedOrigin = new URL(input.origin);
  const port = parsedOrigin.port;
  const serverEntry = join(input.appRoot, ".output", "server", "index.mjs");

  if (!existsSync(serverEntry)) {
    return undefined;
  }

  return startServerProcess({
    args: [serverEntry],
    command: process.execPath,
    cwd: input.appRoot,
    env: {
      HOST: parsedOrigin.hostname,
      NITRO_HOST: parsedOrigin.hostname,
      NITRO_PORT: port,
      PORT: port,
    },
  }).then(installProcessShutdown);
}

export async function resolveEveDestinationPrefix(input: {
  readonly appRoot: string;
  readonly devServerTimeoutMs?: number;
  readonly phase: string;
  readonly productionDestinationPrefix: string;
  readonly productionServerOrigin?: string;
}): Promise<string> {
  const state = getGlobalState();

  if (process.env.NODE_ENV === "production") {
    if (input.phase === NEXT_PHASE_PRODUCTION_BUILD) {
      return input.productionDestinationPrefix;
    }

    const key = `production:${input.appRoot}`;
    let productionServer = state.servers.get(key);
    if (productionServer === undefined) {
      productionServer =
        process.env.VERCEL || input.productionServerOrigin === undefined
          ? undefined
          : startEveProductionServer({
              appRoot: input.appRoot,
              origin: input.productionServerOrigin,
            });
      if (productionServer !== undefined) {
        productionServer = productionServer.catch((error) => {
          state.servers.delete(key);
          throw error;
        });
        state.servers.set(key, productionServer);
      }
    }

    if (productionServer !== undefined) {
      return (await productionServer).origin;
    }

    return input.productionDestinationPrefix;
  }

  const configuredEveBaseUrl = readEveBaseUrlEnvironment();
  if (configuredEveBaseUrl !== undefined) {
    return configuredEveBaseUrl;
  }

  if (process.env.NODE_ENV !== "development") {
    return input.productionDestinationPrefix;
  }

  const key = `dev:${input.appRoot}`;
  let server = state.servers.get(key);

  if (server === undefined) {
    server = resolveSharedDevelopmentServer({
      appRoot: input.appRoot,
      timeoutMs: input.devServerTimeoutMs ?? DEVELOPMENT_SERVER_TIMEOUT_MS,
    }).catch((error) => {
      state.servers.delete(key);
      throw error;
    });
    state.servers.set(key, server);
  }

  return (await server).origin;
}
