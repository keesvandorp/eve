import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";

import { build as buildNitro, createDevServer, prepare } from "nitro/builder";
import type { Nitro } from "nitro/types";

import { createApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { createNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import type { AuthoredSourceWatcherHandle } from "#internal/nitro/host/dev-authored-source-watcher.js";
import { prepareApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import {
  type DevelopmentServerOwner,
  DevelopmentServerState,
  type DevelopmentServerStateMutationError,
} from "#internal/nitro/host/dev-server-state.js";
import { toErrorMessage } from "#shared/errors.js";
import { isEveServerHealthy } from "#shared/eve-server-health.js";
import { isLocalDevelopmentServerUrl } from "#services/dev-client/local-host.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import {
  pruneLocalSandboxTemplatesInBackground,
  stopDevelopmentSandboxResources,
} from "#execution/sandbox/bindings/local.js";
import { startDevelopmentSandboxPrewarmInBackground } from "#execution/sandbox/development-prewarm.js";
import {
  clearInitializedDevelopmentSandboxBackendNames,
  createDevelopmentSandboxRunId,
  EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV,
  getInitializedDevelopmentSandboxBackendNames,
} from "#execution/sandbox/development-run.js";
import type {
  DevelopmentServerHandle,
  DevelopmentServerOptions,
  StartedDevelopmentServer,
} from "#internal/nitro/host/types.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { pruneDevelopmentRuntimeArtifactsSnapshotsInBackground } from "#internal/nitro/dev-runtime-artifacts.js";
import {
  DEFAULT_DEVELOPMENT_SERVER_PORT,
  MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS,
} from "#internal/nitro/host/ports.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { eveDevArguments } from "#setup/primitives/index.js";
import { devBootPhase } from "#internal/dev-boot-progress.js";

const MAX_ALLOWED_DEVELOPMENT_SERVER_PORT = 65_535;
const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
const PORT_ENV = "PORT";
const DEFAULT_DEVELOPMENT_SERVER_HOST = "127.0.0.1";
const IPV6_LOOPBACK_HOSTNAME = "[::1]";
const DEVELOPMENT_SERVER_URL_PLACEHOLDER = "http://localhost:PORT";

/**
 * Hostnames Nitro/srvx surface when listening on an IPv6 wildcard interface.
 * They are valid bind targets but invalid as connect targets.
 */
const IPV6_WILDCARD_LISTEN_HOSTNAMES: ReadonlySet<string> = new Set(["[::]", "::"]);

/**
 * Rewrites a server URL whose hostname is a wildcard listen address into a
 * loopback URL on the same address family.
 */
export function normalizeDevelopmentServerClientUrl(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (IPV6_WILDCARD_LISTEN_HOSTNAMES.has(url.hostname)) {
    url.hostname = IPV6_LOOPBACK_HOSTNAME;
    return url.toString();
  }

  if (url.hostname === "0.0.0.0") {
    url.hostname = DEFAULT_DEVELOPMENT_SERVER_HOST;
    return url.toString();
  }

  return serverUrl;
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

type NitroDevelopmentServer = ReturnType<typeof createDevServer>;
type NitroDevelopmentServerUpgrade = NitroDevelopmentServer["upgrade"];

function resolveDevelopmentServerPort(port: number | string | undefined): number {
  const resolvedPort =
    typeof port === "string" ? Number(port) : (port ?? DEFAULT_DEVELOPMENT_SERVER_PORT);

  if (
    !Number.isInteger(resolvedPort) ||
    resolvedPort < 0 ||
    resolvedPort > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT
  ) {
    throw new Error(
      `Invalid development server port "${String(port)}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  return resolvedPort;
}

function readEnvironmentPort(): number | undefined {
  const raw = process.env[PORT_ENV];

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT) {
    throw new Error(
      `Invalid ${PORT_ENV} environment variable "${raw}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  return parsed;
}

function formatKillCommand(processId: number): string {
  if (process.platform === "win32") {
    return `taskkill /PID ${processId}`;
  }

  return `kill ${processId}`;
}

async function detectDevelopmentCommandPackageManager(
  appRoot: string,
): Promise<PackageManagerKind> {
  try {
    return (await detectPackageManager(appRoot)).kind;
  } catch {
    return "pnpm";
  }
}

async function formatDevelopmentServerConnectCommand(
  appRoot: string,
  serverUrl: string,
): Promise<string> {
  const packageManager = await detectDevelopmentCommandPackageManager(appRoot);
  return [packageManager, ...eveDevArguments(packageManager), serverUrl].join(" ");
}

async function createDevelopmentServerAlreadyRunningError(
  appRoot: string,
  owner: DevelopmentServerOwner,
): Promise<Error> {
  const connectUrl = owner.kind === "ready" ? owner.url : DEVELOPMENT_SERVER_URL_PLACEHOLDER;
  const connectCommand = await formatDevelopmentServerConnectCommand(appRoot, connectUrl);
  return new Error(
    [
      `A dev server is already running for this eve agent (pid ${owner.pid}).`,
      `To connect to the existing instance, run: ${connectCommand}`,
      `To stop it, run: ${formatKillCommand(owner.pid)}`,
    ].join("\n"),
  );
}

function createDevelopmentServerStateMutationError(
  action: "mark dev server as closing" | "publish dev server state" | "release dev server state",
  error: DevelopmentServerStateMutationError,
): Error {
  if (error.kind === "ownership-lost") {
    const owner = error.pid === null ? "another process" : `pid ${error.pid}`;
    return new Error(`Could not ${action} because ownership moved to ${owner}.`);
  }

  if (error.kind === "invalid-transition") {
    return new Error(
      `Could not ${action} because the ${error.from} → ${error.to} transition is invalid.`,
    );
  }

  return new Error(`Could not ${action}: ${toErrorMessage(error.cause)}`, {
    cause: error.cause,
  });
}

function resolveDevelopmentServerPorts(input: {
  readonly port: number | string | undefined;
  readonly retryOnAddressInUse: boolean;
}): readonly [number, ...number[]] {
  const resolvedPort = resolveDevelopmentServerPort(input.port);

  if (resolvedPort === 0 || !input.retryOnAddressInUse) {
    return [resolvedPort];
  }

  const ports: number[] = [];

  for (let offset = 0; offset < MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS; offset += 1) {
    const candidate = resolvedPort + offset;

    if (candidate > 65_535) {
      break;
    }

    ports.push(candidate);
  }

  return ports as [number, ...number[]];
}

function installWorkflowLocalQueueEnvironment(serverUrl: string): () => void {
  const previousWorkflowLocalBaseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
  const previousPort = process.env[PORT_ENV];
  const url = new URL(normalizeDevelopmentServerClientUrl(serverUrl));

  process.env[WORKFLOW_LOCAL_BASE_URL_ENV] = url.origin;
  if (url.port) {
    process.env[PORT_ENV] = url.port;
  }

  return () => {
    if (previousWorkflowLocalBaseUrl === undefined) {
      delete process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
    } else {
      process.env[WORKFLOW_LOCAL_BASE_URL_ENV] = previousWorkflowLocalBaseUrl;
    }

    if (previousPort === undefined) {
      delete process.env[PORT_ENV];
    } else {
      process.env[PORT_ENV] = previousPort;
    }
  };
}

function attachTemporarySocketErrorHandler(socket: Socket): () => void {
  // Keep early socket failures from becoming uncaught EventEmitter errors
  // while Nitro/httpxy installs its own upgrade-path listeners.
  const onSocketError = () => {};

  socket.once("error", onSocketError);

  return () => {
    socket.off("error", onSocketError);
  };
}

function shouldProxyDevelopmentServerWebSocketUpgrades(nitro: Nitro): boolean {
  return nitro.options.features.websocket === true || nitro.options.experimental.websocket === true;
}

function guardDevelopmentServerWebSocketUpgrades(
  nitro: Nitro,
  devServer: NitroDevelopmentServer,
): void {
  const originalUpgrade = devServer.upgrade.bind(devServer) as NitroDevelopmentServerUpgrade;
  const websocketEnabled = shouldProxyDevelopmentServerWebSocketUpgrades(nitro);
  const guardedUpgrade: NitroDevelopmentServerUpgrade = async (
    req: IncomingMessage,
    socket: Socket,
    head: unknown,
  ) => {
    if (!websocketEnabled) {
      if (!socket.destroyed) {
        socket.destroy();
      }
      return;
    }

    const removeSocketErrorHandler = attachTemporarySocketErrorHandler(socket);

    try {
      await originalUpgrade(req, socket, head);
    } catch {
      if (!socket.destroyed) {
        socket.destroy();
      }
    } finally {
      removeSocketErrorHandler();
    }
  };

  devServer.upgrade = guardedUpgrade;
}

async function closeDevelopmentServerResources(input: {
  readonly authoredSourceWatcher: AuthoredSourceWatcherHandle | undefined;
  readonly devServer: NitroDevelopmentServer | undefined;
  readonly developmentSandboxRunId: string;
  readonly nitro: Nitro | undefined;
}): Promise<{ readonly errors: readonly unknown[]; readonly listenerClosed: boolean }> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  };

  const authoredSourceWatcher = input.authoredSourceWatcher;
  if (authoredSourceWatcher !== undefined) {
    await attempt(() => authoredSourceWatcher.close());
  }
  const devServer = input.devServer;
  const listenerClosed = devServer === undefined ? true : await attempt(() => devServer.close());
  const nitro = input.nitro;
  if (nitro !== undefined) {
    await attempt(() => nitro.close());
  }
  await attempt(() =>
    stopDevelopmentSandboxResources({
      backendNames: getInitializedDevelopmentSandboxBackendNames(input.developmentSandboxRunId),
      devRunId: input.developmentSandboxRunId,
      log: (message) => console.warn(`[eve:dev] ${message}`),
    }),
  );

  return { errors, listenerClosed };
}

function createDevelopmentServerCleanupError(errors: readonly unknown[]): Error | undefined {
  if (errors.length === 0) {
    return undefined;
  }

  if (errors.length === 1) {
    const error = errors[0];
    return error instanceof Error
      ? error
      : new Error(`Failed to close the development server: ${toErrorMessage(error)}`, {
          cause: error,
        });
  }

  return new AggregateError(errors, "Multiple development-server resources failed to close.");
}

function createDevelopmentServerStartupCleanupError(
  startupError: unknown,
  cleanupErrors: readonly unknown[],
): AggregateError {
  return new AggregateError(
    [startupError, ...cleanupErrors],
    `${toErrorMessage(startupError)} Cleanup also failed.`,
    { cause: startupError },
  );
}

async function listenForDevelopmentServer(input: {
  readonly devServer: NitroDevelopmentServer;
  readonly host?: string;
  readonly port: number | string | undefined;
  readonly retryOnAddressInUse: boolean;
}) {
  const ports = resolveDevelopmentServerPorts({
    port: input.port,
    retryOnAddressInUse: input.retryOnAddressInUse,
  });
  let lastError: unknown;

  for (const port of ports) {
    const server = input.devServer.listen({
      hostname: input.host,
      port,
      silent: true,
    });

    try {
      await server.ready();
      return server;
    } catch (error) {
      lastError = error;
      await server.close().catch(() => {});

      if (!isAddressInUseError(error)) {
        throw error;
      }

      if (!input.retryOnAddressInUse) {
        throw error;
      }
    }
  }

  throw new Error(
    `Failed to start Nitro dev server after ${ports.length} attempts. Tried ports ${ports.join(", ")}.`,
    {
      cause: lastError,
    },
  );
}

/**
 * Starts the development Nitro server for an eve application.
 *
 * Authored schedules are never registered with Nitro's cron scheduler in
 * dev mode. To fire one authored schedule on demand, `POST` the dev-only
 * `/eve/v1/dev/schedules/:scheduleId` route — the handler returns
 * `{ scheduleId, sessionIds }` so callers can subscribe to the existing
 * per-session stream route.
 */
export function startDevelopmentServer(
  rootDir: string,
  options?: DevelopmentServerOptions & { existing?: "reject" },
): Promise<StartedDevelopmentServer>;
export function startDevelopmentServer(
  rootDir: string,
  options?: DevelopmentServerOptions,
): Promise<DevelopmentServerHandle>;
export async function startDevelopmentServer(
  rootDir: string,
  options: DevelopmentServerOptions = {},
): Promise<DevelopmentServerHandle> {
  // Marks this process tree as an `eve dev` session so runtime features
  // that must never run in production (for example auto-installing
  // optional sandbox engine packages) can gate on it.
  process.env[EVE_DEV_ENV_FLAG] ??= "1";

  const project = await resolveDiscoveryProject(rootDir);
  loadDevelopmentEnvironmentFiles(project.appRoot);

  const environmentPort = readEnvironmentPort();
  const requestedPort = options.port ?? environmentPort;
  const hasExplicitEndpoint =
    options.host !== undefined || options.port !== undefined || environmentPort !== undefined;
  const state = new DevelopmentServerState(project);
  const claim = await state.claim();

  if (!claim.ok) {
    throw new Error(
      `Could not determine whether a dev server is already running: ${toErrorMessage(claim.error.cause)}`,
      { cause: claim.error.cause },
    );
  }

  if (claim.value.kind === "occupied") {
    const owner = claim.value.owner;
    if (
      options.existing === "attach-if-unconfigured" &&
      !hasExplicitEndpoint &&
      owner.kind === "ready" &&
      isLocalDevelopmentServerUrl(owner.url) &&
      (await isEveServerHealthy(owner.url))
    ) {
      return {
        kind: "existing",
        appRoot: project.appRoot,
        url: owner.url,
      };
    }
    throw await createDevelopmentServerAlreadyRunningError(project.appRoot, owner);
  }

  const stateClaim = claim.value.claim;
  const previousDevelopmentSandboxRunId = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
  const developmentSandboxRunId = createDevelopmentSandboxRunId();
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = developmentSandboxRunId;
  let nitro: Nitro | undefined;
  let devServer: NitroDevelopmentServer | undefined;
  let restoreWorkflowLocalQueueEnvironment: (() => void) | undefined;
  let authoredSourceWatcher: AuthoredSourceWatcherHandle | undefined;
  const releaseDevelopmentProcess = () => stateClaim.release();

  try {
    const preparedHost = await devBootPhase(
      "compiling agent",
      () => prepareApplicationHost(project.appRoot, { dev: true }),
      options.onBootProgress,
    );
    pruneDevelopmentRuntimeArtifactsSnapshotsInBackground(preparedHost.appRoot);
    const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(
      createNitroArtifactsConfig({
        appRoot: preparedHost.appRoot,
        dev: true,
      }),
    );
    startDevelopmentSandboxPrewarmInBackground({
      appRoot: preparedHost.appRoot,
      compiledArtifactsSource,
    });
    pruneLocalSandboxTemplatesInBackground(preparedHost.appRoot);
    const activeNitro = await devBootPhase(
      "creating dev server",
      () => createApplicationNitro(preparedHost, true),
      options.onBootProgress,
    );
    nitro = activeNitro;
    devServer = createDevServer(activeNitro);
    const activeDevServer = devServer;
    guardDevelopmentServerWebSocketUpgrades(activeNitro, devServer);
    const hostname =
      options.host ?? activeNitro.options.devServer.hostname ?? DEFAULT_DEVELOPMENT_SERVER_HOST;
    const retryOnAddressInUse = requestedPort === undefined;
    const server = await devBootPhase(
      "binding port",
      () =>
        listenForDevelopmentServer({
          devServer: activeDevServer,
          host: hostname,
          port: requestedPort,
          retryOnAddressInUse,
        }),
      options.onBootProgress,
    );

    if (!server.url) {
      throw new Error("Nitro dev server did not expose a URL.");
    }

    const serverUrl = normalizeDevelopmentServerClientUrl(server.url);
    restoreWorkflowLocalQueueEnvironment = installWorkflowLocalQueueEnvironment(serverUrl);
    await devBootPhase(
      "building dev bundle",
      async () => {
        await prepare(activeNitro);
        await buildNitro(activeNitro);
      },
      options.onBootProgress,
    );

    authoredSourceWatcher = await devBootPhase(
      "starting file watcher",
      async () => {
        const { startAuthoredSourceWatcher } =
          await import("#internal/nitro/host/dev-authored-source-watcher.js");
        return startAuthoredSourceWatcher({
          nitro: activeNitro,
          preparedHost,
        });
      },
      options.onBootProgress,
    );
    const publication = await stateClaim.publish(serverUrl);
    if (!publication.ok) {
      throw createDevelopmentServerStateMutationError(
        "publish dev server state",
        publication.error,
      );
    }
    const restoreWorkflowLocalQueueEnvironmentOnClose = restoreWorkflowLocalQueueEnvironment;
    if (restoreWorkflowLocalQueueEnvironmentOnClose === undefined) {
      throw new Error("Workflow local queue environment was not initialized.");
    }

    const authoredSourceWatcherOnClose = authoredSourceWatcher;
    const devServerOnClose = devServer;
    const nitroOnClose = activeNitro;
    let cleanupResult:
      | { readonly errors: readonly unknown[]; readonly listenerClosed: boolean }
      | undefined;
    let closePromise: Promise<void> | undefined;
    return {
      kind: "started",
      appRoot: project.appRoot,
      async close() {
        if (closePromise !== undefined) {
          await closePromise;
          return;
        }

        let releaseFailed = false;
        const currentClose = (async () => {
          if (cleanupResult === undefined) {
            const closing = await stateClaim.markClosing();
            if (!closing.ok && closing.error.kind !== "ownership-lost") {
              throw createDevelopmentServerStateMutationError(
                "mark dev server as closing",
                closing.error,
              );
            }

            cleanupResult = await closeDevelopmentServerResources({
              authoredSourceWatcher: authoredSourceWatcherOnClose,
              devServer: devServerOnClose,
              developmentSandboxRunId,
              nitro: nitroOnClose,
            });
            try {
              clearInitializedDevelopmentSandboxBackendNames(developmentSandboxRunId);
            } finally {
              restoreWorkflowLocalQueueEnvironmentOnClose();
              restoreDevelopmentSandboxRunId(previousDevelopmentSandboxRunId);
            }
          }

          const cleanupErrors = [...cleanupResult.errors];
          if (cleanupResult.listenerClosed) {
            try {
              await releaseDevelopmentProcess();
            } catch (cause) {
              releaseFailed = true;
              cleanupErrors.push(
                createDevelopmentServerStateMutationError("release dev server state", {
                  kind: "io",
                  cause,
                }),
              );
            }
          }

          const cleanupError = createDevelopmentServerCleanupError(cleanupErrors);
          if (cleanupError !== undefined) {
            throw cleanupError;
          }
        })();
        closePromise = currentClose;
        try {
          await currentClose;
        } catch (error) {
          if ((cleanupResult === undefined || releaseFailed) && closePromise === currentClose) {
            closePromise = undefined;
          }
          throw error;
        }
      },
      url: serverUrl,
    };
  } catch (error) {
    const cleanup = await closeDevelopmentServerResources({
      authoredSourceWatcher,
      devServer,
      developmentSandboxRunId,
      nitro,
    });
    const cleanupErrors = [...cleanup.errors];
    restoreWorkflowLocalQueueEnvironment?.();
    clearInitializedDevelopmentSandboxBackendNames(developmentSandboxRunId);
    if (cleanup.listenerClosed) {
      try {
        await releaseDevelopmentProcess();
      } catch (cause) {
        cleanupErrors.push(
          createDevelopmentServerStateMutationError("release dev server state", {
            kind: "io",
            cause,
          }),
        );
      }
    }
    restoreDevelopmentSandboxRunId(previousDevelopmentSandboxRunId);
    if (cleanupErrors.length > 0) {
      throw createDevelopmentServerStartupCleanupError(error, cleanupErrors);
    }
    throw error;
  }
}

function restoreDevelopmentSandboxRunId(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
    return;
  }
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = previous;
}
