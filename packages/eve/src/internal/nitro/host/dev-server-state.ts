import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "#compiled/zod/index.js";
import { err, ok, type Result } from "#shared/result.js";

const STATE_FILE_NAME = "dev-server-state.v1.json";
const LOCK_FILE_NAME = "dev-server-state.lock.sqlite";
const LEGACY_PROCESS_ID_FILE_NAME = "dev-process.pid";
const LEGACY_SERVER_FILE_NAME = "dev-server.json";
const LOCK_POLL_MS = 50;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;

const processIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ownerTokenSchema = z.string().min(1);
const httpServerUrlSchema = z
  .string()
  .url()
  .refine(isHttpServerUrl, "Expected an HTTP(S) server URL.");
const startingDevServerStateSchema = z
  .object({
    kind: z.literal("starting"),
    ownerToken: ownerTokenSchema,
    pid: processIdSchema,
  })
  .strict();
const readyDevServerStateSchema = z
  .object({
    kind: z.literal("ready"),
    ownerToken: ownerTokenSchema,
    pid: processIdSchema,
    url: httpServerUrlSchema,
  })
  .strict();
const closingDevServerStateSchema = z
  .object({
    kind: z.literal("closing"),
    ownerToken: ownerTokenSchema,
    pid: processIdSchema,
  })
  .strict();
const devServerStateSchema = z.discriminatedUnion("kind", [
  startingDevServerStateSchema,
  readyDevServerStateSchema,
  closingDevServerStateSchema,
]);
const legacyDevServerMetadataSchema = z.object({
  pid: processIdSchema,
  url: httpServerUrlSchema,
});

/** Persisted ownership state for one app root. */
export type DevServerState = Readonly<z.infer<typeof devServerStateSchema>>;

/** A live process that currently owns the app root. */
export type DevServerOwner =
  | { readonly kind: "starting"; readonly pid: number }
  | { readonly kind: "ready"; readonly pid: number; readonly url: string }
  | { readonly kind: "closing"; readonly pid: number };

/** The result of atomically claiming a project root. */
export type DevServerClaim =
  | { readonly kind: "claimed"; readonly ownerToken: string }
  | { readonly kind: "occupied"; readonly owner: DevServerOwner };

/** Why {@link DevServerStateStore.claim} could not inspect or persist state. */
export type DevServerClaimError = { readonly kind: "io"; readonly cause: unknown };

/** Why an owned dev-server state transition could not be persisted. */
export type DevServerStateMutationError =
  | { readonly kind: "io"; readonly cause: unknown }
  | { readonly kind: "invalid-transition"; readonly from: "closing"; readonly to: "ready" }
  | { readonly kind: "ownership-lost"; readonly pid: number | null };

/** Returns whether the operating system still has a process with `pid`. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error, "EPERM");
  }
}

/**
 * Owns the versioned dev-server record for one app root. SQLite provides the
 * cross-process mutex; the JSON record remains the inspectable source of
 * ownership and attachment data.
 */
export class DevServerStateStore {
  readonly #stateDir: string;
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #legacyProcessIdPath: string;
  readonly #legacyServerPath: string;

  constructor(appRoot: string) {
    this.#stateDir = join(appRoot, ".eve");
    this.#statePath = join(this.#stateDir, STATE_FILE_NAME);
    this.#lockPath = join(this.#stateDir, LOCK_FILE_NAME);
    this.#legacyProcessIdPath = join(this.#stateDir, LEGACY_PROCESS_ID_FILE_NAME);
    this.#legacyServerPath = join(this.#stateDir, LEGACY_SERVER_FILE_NAME);
  }

  /** Atomically returns the live owner or records a fresh starting claim. */
  async claim(pid: number): Promise<Result<DevServerClaim, DevServerClaimError>> {
    try {
      return await this.#withLock(async () => {
        const loaded = await this.#load();

        if (loaded.kind === "corrupt") {
          throw this.#createCorruptStateError(loaded.cause);
        }

        if (loaded.kind === "ok" && isProcessRunning(loaded.state.pid)) {
          return ok({ kind: "occupied", owner: stateToOwner(loaded.state) });
        }

        const legacyOwner = await this.#loadLegacyOwner();
        if (legacyOwner !== undefined) {
          return ok({ kind: "occupied", owner: legacyOwner });
        }

        await this.#removeLegacyState();
        const ownerToken = randomUUID();
        await this.#writeClaimRecords({ kind: "starting", ownerToken, pid });
        return ok({ kind: "claimed", ownerToken });
      });
    } catch (cause) {
      const owner = await this.#loadOwnerWithoutLock().catch(() => undefined);
      return owner === undefined ? err({ kind: "io", cause }) : ok({ kind: "occupied", owner });
    }
  }

  /** Publishes the URL for a claim that still owns the app root. */
  async publish(input: {
    readonly ownerToken: string;
    readonly url: string;
  }): Promise<Result<void, DevServerStateMutationError>> {
    try {
      return await this.#withLock(async () => {
        const loaded = await this.#load();

        if (loaded.kind === "corrupt") {
          throw this.#createCorruptStateError(loaded.cause);
        }

        if (loaded.kind !== "ok" || loaded.state.ownerToken !== input.ownerToken) {
          return err({
            kind: "ownership-lost",
            pid: loaded.kind === "ok" ? loaded.state.pid : null,
          });
        }

        if (loaded.state.kind === "closing") {
          return err({ kind: "invalid-transition", from: "closing", to: "ready" });
        }

        await this.#writeLegacyMetadata(loaded.state.pid, input.url);
        try {
          await this.#writeAtomic({
            kind: "ready",
            ownerToken: input.ownerToken,
            pid: loaded.state.pid,
            url: input.url,
          });
        } catch (cause) {
          try {
            await this.#removeLegacyMetadataForProcess(loaded.state.pid);
          } catch (rollbackCause) {
            throw new AggregateError(
              [cause, rollbackCause],
              "Failed to publish dev-server state and remove compatibility metadata.",
            );
          }
          throw cause;
        }
        return ok(undefined);
      });
    } catch (cause) {
      return err({ kind: "io", cause });
    }
  }

  /** Makes an owned server non-attachable before its resources begin closing. */
  async markClosing(ownerToken: string): Promise<Result<void, DevServerStateMutationError>> {
    try {
      return await this.#withLock(async () => {
        const loaded = await this.#load();

        if (loaded.kind === "corrupt") {
          throw this.#createCorruptStateError(loaded.cause);
        }

        if (loaded.kind !== "ok" || loaded.state.ownerToken !== ownerToken) {
          return err({
            kind: "ownership-lost",
            pid: loaded.kind === "ok" ? loaded.state.pid : null,
          });
        }

        await this.#removeLegacyMetadataForProcess(loaded.state.pid);
        await this.#writeAtomic({
          kind: "closing",
          ownerToken,
          pid: loaded.state.pid,
        });
        return ok(undefined);
      });
    } catch (cause) {
      return err({ kind: "io", cause });
    }
  }

  /** Removes the record only when `ownerToken` still owns it. */
  async release(ownerToken: string): Promise<void> {
    await this.#withLock(async () => {
      const loaded = await this.#load();

      if (loaded.kind === "corrupt") {
        throw this.#createCorruptStateError(loaded.cause);
      }

      if (loaded.kind === "ok" && loaded.state.ownerToken === ownerToken) {
        // Remove compatibility files while the old PID marker still blocks
        // legacy Eve processes, then relinquish the versioned claim.
        await this.#removeLegacyStateForProcess(loaded.state.pid);
        await rm(this.#statePath, { force: true });
      }
    });
  }

  async #loadOwnerWithoutLock(): Promise<DevServerOwner | undefined> {
    const loaded = await this.#load();
    if (loaded.kind === "ok" && isProcessRunning(loaded.state.pid)) {
      return stateToOwner(loaded.state);
    }

    return await this.#loadLegacyOwner();
  }

  async #load(): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "corrupt"; readonly cause: unknown }
    | { readonly kind: "ok"; readonly state: DevServerState }
  > {
    let raw: string;

    try {
      raw = await readFile(this.#statePath, "utf8");
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) {
        return { kind: "absent" };
      }
      throw error;
    }

    const state = parseDevServerState(raw);
    return state.ok ? { kind: "ok", state: state.value } : { kind: "corrupt", cause: state.error };
  }

  async #loadLegacyOwner(): Promise<DevServerOwner | undefined> {
    const [processIdRaw, metadataRaw] = await Promise.all([
      readOptionalFile(this.#legacyProcessIdPath),
      readOptionalFile(this.#legacyServerPath),
    ]);
    const processId = processIdRaw === undefined ? undefined : parseLegacyProcessId(processIdRaw);
    if (processId === undefined || !isProcessRunning(processId)) {
      return undefined;
    }

    const metadata = metadataRaw === undefined ? undefined : parseLegacyMetadata(metadataRaw);
    return metadata?.pid === processId
      ? { kind: "ready", pid: processId, url: metadata.url }
      : { kind: "starting", pid: processId };
  }

  #createCorruptStateError(cause: unknown): Error {
    return new Error(`Dev-server state at "${this.#statePath}" is malformed.`, { cause });
  }

  async #removeLegacyState(): Promise<void> {
    await Promise.all([
      rm(this.#legacyProcessIdPath, { force: true }),
      rm(this.#legacyServerPath, { force: true }),
    ]);
  }

  async #removeLegacyStateForProcess(pid: number): Promise<void> {
    await this.#removeLegacyMetadataForProcess(pid);

    const processIdRaw = await readOptionalFile(this.#legacyProcessIdPath);
    const processId = processIdRaw === undefined ? undefined : parseLegacyProcessId(processIdRaw);
    if (processId === pid) {
      await rm(this.#legacyProcessIdPath, { force: true });
    }
  }

  async #removeLegacyMetadataForProcess(pid: number): Promise<void> {
    const metadataRaw = await readOptionalFile(this.#legacyServerPath);
    const metadata = metadataRaw === undefined ? undefined : parseLegacyMetadata(metadataRaw);
    if (metadata?.pid === pid) {
      await rm(this.#legacyServerPath, { force: true });
    }
  }

  async #writeClaimRecords(
    state: Extract<DevServerState, { readonly kind: "starting" }>,
  ): Promise<void> {
    let wroteLegacyProcessId = false;

    try {
      await this.#writeTextAtomic(this.#legacyProcessIdPath, `${state.pid}\n`);
      wroteLegacyProcessId = true;
      await this.#writeAtomic(state);
    } catch (error) {
      if (wroteLegacyProcessId) {
        await this.#removeLegacyStateForProcess(state.pid).catch(() => {});
      }
      throw error;
    }
  }

  async #writeLegacyMetadata(pid: number, url: string): Promise<void> {
    await this.#writeTextAtomic(
      this.#legacyServerPath,
      `${JSON.stringify({ pid, updatedAt: new Date().toISOString(), url }, null, 2)}\n`,
    );
  }

  async #writeAtomic(state: DevServerState): Promise<void> {
    const validatedState = devServerStateSchema.parse(state);
    await this.#writeTextAtomic(this.#statePath, `${JSON.stringify(validatedState)}\n`);
  }

  async #writeTextAtomic(path: string, value: string): Promise<void> {
    await mkdir(this.#stateDir, { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, value, "utf8");
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async #withLock<T>(callback: () => Promise<T>): Promise<T> {
    await mkdir(this.#stateDir, { recursive: true });
    const database = await acquireSqliteLock(this.#lockPath);

    try {
      return await callback();
    } finally {
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  }
}

async function acquireSqliteLock(lockPath: string): Promise<DatabaseSync> {
  const startedAt = Date.now();

  for (;;) {
    const database = new DatabaseSync(lockPath, { timeout: 0 });

    try {
      database.exec("BEGIN IMMEDIATE");
      return database;
    } catch (error) {
      database.close();

      if (!isSqliteBusyError(error)) {
        throw error;
      }

      if (Date.now() - startedAt > LOCK_ACQUIRE_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring dev-server state lock at "${lockPath}".`, {
          cause: error,
        });
      }

      await delay(LOCK_POLL_MS);
    }
  }
}

function stateToOwner(state: DevServerState): DevServerOwner {
  return state.kind === "ready"
    ? { kind: "ready", pid: state.pid, url: state.url }
    : { kind: state.kind, pid: state.pid };
}

function parseDevServerState(raw: string): Result<DevServerState, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    return err(error);
  }

  const parsed = devServerStateSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}

function parseLegacyMetadata(
  raw: string,
): Readonly<z.infer<typeof legacyDevServerMetadataSchema>> | undefined {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = legacyDevServerMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseLegacyProcessId(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);
  return processIdSchema.safeParse(parsed).success ? parsed : undefined;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isHttpServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_SQLITE_ERROR" &&
    "errcode" in error &&
    error.errcode === 5
  );
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
