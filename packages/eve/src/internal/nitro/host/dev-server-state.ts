import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "#compiled/zod/index.js";
import { httpServerUrlSchema } from "#shared/network-address.js";
import { err, ok, type Result } from "#shared/result.js";

const STATE_FILE_NAME = "dev-server-state.v1.json";
const LOCK_DIRECTORY_NAME = "dev-server-state.lock";
const LEGACY_PROCESS_ID_FILE_NAME = "dev-process.pid";
const LEGACY_SERVER_FILE_NAME = "dev-server.json";
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_OWNER_FILE_NAME = "owner.json";
const LOCK_POLL_MS = 50;

const processIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const legacyProcessIdSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(processIdSchema);
const ownerTokenSchema = z.string().min(1);
const developmentServerLockOwnerSchema = z
  .object({
    pid: processIdSchema,
    token: ownerTokenSchema,
  })
  .strict();
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
type PersistedDevelopmentServerState = Readonly<z.infer<typeof devServerStateSchema>>;
type DevelopmentServerLockOwner = Readonly<z.infer<typeof developmentServerLockOwnerSchema>>;

/** A live process that currently owns the app root. */
export type DevelopmentServerOwner =
  | { readonly kind: "starting"; readonly pid: number }
  | { readonly kind: "ready"; readonly pid: number; readonly url: string }
  | { readonly kind: "closing"; readonly pid: number };

/** The live ownership visible to processes that do not own the claim. */
export type DevelopmentServerObservation = { readonly kind: "vacant" } | DevelopmentServerOwner;

/** Mutation capability held only by the process that won a claim. */
export interface DevelopmentServerClaim {
  readonly pid: number;
  markClosing(): Promise<Result<void, DevelopmentServerStateMutationError>>;
  publish(url: string): Promise<Result<void, DevelopmentServerStateMutationError>>;
  release(): Promise<void>;
}

/** The result of atomically claiming a project root. */
export type DevelopmentServerClaimAttempt =
  | { readonly kind: "claimed"; readonly claim: DevelopmentServerClaim }
  | { readonly kind: "occupied"; readonly owner: DevelopmentServerOwner };

/** Why {@link DevelopmentServerState.claim} could not inspect or persist state. */
export type DevelopmentServerStateError = { readonly kind: "io"; readonly cause: unknown };

/** Why an owned dev-server state transition could not be persisted. */
export type DevelopmentServerStateMutationError =
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
 * Coordinates the one development server allowed to write an app root's
 * generated `.eve` artifacts.
 *
 * Any process that enters `startDevelopmentServer()` is eligible to own the
 * root. Today that includes direct `eve dev` and local `eve eval` processes,
 * plus the `eve dev` children started by Next.js, Nuxt, or SvelteKit adapters.
 * They can start in separate operating-system processes, so `claim()`,
 * `publish()`, `markClosing()`, and `release()` use a filesystem lock around
 * each read-decide-write transition. This prevents two processes from claiming
 * the same root or an old process from overwriting its successor.
 *
 * The versioned JSON record is authoritative because `claim()` creates its
 * random owner token while holding that lock, and later mutations must present
 * the same token. Its phase, PID, and ready URL let another CLI or adapter
 * observe the owner and attach to it instead of starting a competing server.
 *
 * @example
 * ```ts
 * const state = new DevelopmentServerState({ appRoot });
 * const attempt = await state.claim();
 * if (!attempt.ok) throw attempt.error.cause;
 * if (attempt.value.kind === "claimed") {
 *   const published = await attempt.value.claim.publish("http://127.0.0.1:3000/");
 *   if (!published.ok) throw published.error;
 * } else {
 *   console.log(attempt.value.owner);
 * }
 * ```
 */
export class DevelopmentServerState {
  readonly appRoot: string;
  readonly #stateDir: string;
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #legacyProcessIdPath: string;
  readonly #legacyServerPath: string;

  constructor(project: { readonly appRoot: string }) {
    this.appRoot = project.appRoot;
    this.#stateDir = join(this.appRoot, ".eve");
    this.#statePath = join(this.#stateDir, STATE_FILE_NAME);
    this.#lockPath = join(this.#stateDir, LOCK_DIRECTORY_NAME);
    this.#legacyProcessIdPath = join(this.#stateDir, LEGACY_PROCESS_ID_FILE_NAME);
    this.#legacyServerPath = join(this.#stateDir, LEGACY_SERVER_FILE_NAME);
  }

  /** Returns the live owner without exposing its mutation capability. */
  async inspect(
    options: { readonly timeoutMs?: number } = {},
  ): Promise<Result<DevelopmentServerObservation, DevelopmentServerStateError>> {
    try {
      const owner = await this.#withLock(() => this.#loadOwner(), options);
      return ok(owner ?? { kind: "vacant" });
    } catch (cause) {
      return err({ kind: "io", cause });
    }
  }

  /** Atomically returns the live owner or records this process as a fresh starting claim. */
  async claim(): Promise<Result<DevelopmentServerClaimAttempt, DevelopmentServerStateError>> {
    const pid = process.pid;
    let enteredCriticalSection = false;
    try {
      return await this.#withLock(async () => {
        enteredCriticalSection = true;
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
        return ok({ kind: "claimed", claim: this.#createClaim(pid, ownerToken) });
      });
    } catch (cause) {
      if (enteredCriticalSection) {
        return err({ kind: "io", cause });
      }
      const owner = await this.#loadOwner().catch(() => undefined);
      return owner === undefined ? err({ kind: "io", cause }) : ok({ kind: "occupied", owner });
    }
  }

  #createClaim(pid: number, ownerToken: string): DevelopmentServerClaim {
    return Object.freeze({
      pid,
      markClosing: () => this.#markClosing(ownerToken),
      publish: (url: string) => this.#publish(ownerToken, url),
      release: () => this.#release(ownerToken),
    });
  }

  /** Publishes the URL for a claim that still owns the app root. */
  async #publish(
    ownerToken: string,
    url: string,
  ): Promise<Result<void, DevelopmentServerStateMutationError>> {
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

        if (loaded.state.kind === "closing") {
          return err({ kind: "invalid-transition", from: "closing", to: "ready" });
        }

        await this.#writeLegacyMetadata(loaded.state.pid, url);
        try {
          await this.#writeAtomic({
            kind: "ready",
            ownerToken,
            pid: loaded.state.pid,
            url,
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
  async #markClosing(
    ownerToken: string,
  ): Promise<Result<void, DevelopmentServerStateMutationError>> {
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
  async #release(ownerToken: string): Promise<void> {
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

  async #loadOwner(): Promise<DevelopmentServerOwner | undefined> {
    const loaded = await this.#load();
    if (loaded.kind === "corrupt") {
      throw this.#createCorruptStateError(loaded.cause);
    }

    if (loaded.kind === "ok" && isProcessRunning(loaded.state.pid)) {
      return stateToOwner(loaded.state);
    }

    return await this.#loadLegacyOwner();
  }

  async #load(): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "corrupt"; readonly cause: unknown }
    | { readonly kind: "ok"; readonly state: PersistedDevelopmentServerState }
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

  async #loadLegacyOwner(): Promise<DevelopmentServerOwner | undefined> {
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
    state: Extract<PersistedDevelopmentServerState, { readonly kind: "starting" }>,
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

  async #writeAtomic(state: PersistedDevelopmentServerState): Promise<void> {
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

  async #withLock<T>(
    callback: () => Promise<T>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<T> {
    const lock = new DevelopmentServerFilesystemLock(
      this.#lockPath,
      options.timeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS,
    );
    await lock.acquire();

    try {
      return await callback();
    } finally {
      await lock.release();
    }
  }
}

class DevelopmentServerFilesystemLock {
  readonly #deadline: number;
  readonly #lockPath: string;
  readonly #owner: DevelopmentServerLockOwner = {
    pid: process.pid,
    token: randomUUID(),
  };
  readonly #stagingPath: string;
  readonly #timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    this.#deadline = Date.now() + timeoutMs;
    this.#lockPath = lockPath;
    this.#stagingPath = `${lockPath}.pending.${String(process.pid)}.${this.#owner.token}`;
    this.#timeoutMs = timeoutMs;
  }

  async acquire(): Promise<void> {
    await this.#stageOwnerDirectory();
    let firstAttempt = true;

    try {
      for (;;) {
        if (!firstAttempt && Date.now() >= this.#deadline) {
          throw this.#createTimeoutError();
        }
        firstAttempt = false;

        try {
          await rename(this.#stagingPath, this.#lockPath);
          return;
        } catch (error) {
          if (!(await pathExists(this.#lockPath))) {
            if (isLockContentionError(error)) {
              continue;
            }
            throw error;
          }
        }

        const observed = await readDevelopmentServerLockOwner(this.#lockPath);
        if (observed === undefined) {
          if (await pathExists(this.#lockPath)) {
            await this.#waitForRetry();
          }
          continue;
        }

        if (!isProcessRunning(observed.pid)) {
          await this.#retireDeadOwner(observed);
        }

        await this.#waitForRetry();
      }
    } finally {
      await rm(this.#stagingPath, { force: true, recursive: true }).catch(() => {});
    }
  }

  async release(): Promise<void> {
    const observed = await readDevelopmentServerLockOwner(this.#lockPath);
    if (observed === undefined) {
      if (await pathExists(this.#lockPath)) {
        throw new Error(`Development-server lock at "${this.#lockPath}" is malformed.`);
      }
      return;
    }
    if (!sameDevelopmentServerLockOwner(observed, this.#owner)) {
      return;
    }

    const retiredPath = `${this.#lockPath}.released.${this.#owner.token}.${randomUUID()}`;
    try {
      await rename(this.#lockPath, retiredPath);
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    // The rename relinquished ownership. Failure to clean the detached
    // directory cannot invalidate the completed critical section.
    await rm(retiredPath, { force: true, recursive: true }).catch(() => {});
  }

  async #stageOwnerDirectory(): Promise<void> {
    await mkdir(dirname(this.#lockPath), { recursive: true });
    try {
      await mkdir(this.#stagingPath);
      await writeFile(
        join(this.#stagingPath, LOCK_OWNER_FILE_NAME),
        `${JSON.stringify(developmentServerLockOwnerSchema.parse(this.#owner))}\n`,
        "utf8",
      );
    } catch (error) {
      await rm(this.#stagingPath, { force: true, recursive: true }).catch(() => {});
      throw error;
    }
  }

  async #retireDeadOwner(observed: DevelopmentServerLockOwner): Promise<void> {
    const current = await readDevelopmentServerLockOwner(this.#lockPath);
    if (!sameDevelopmentServerLockOwner(current, observed) || isProcessRunning(observed.pid)) {
      return;
    }

    const retiredPath = `${this.#lockPath}.retired.${hashOwnerToken(observed.token)}`;
    try {
      await rename(this.#lockPath, retiredPath);
    } catch (error) {
      if ((await pathExists(retiredPath)) || !(await pathExists(this.#lockPath))) {
        return;
      }
      throw error;
    }

    // Keep this non-empty generation marker. Delayed recoverers target the
    // same path, so they cannot rename a newer owner after the lock is reused.
  }

  async #waitForRetry(): Promise<void> {
    const remainingMs = this.#deadline - Date.now();
    if (remainingMs <= 0) {
      throw this.#createTimeoutError();
    }
    await delay(Math.min(LOCK_POLL_MS, remainingMs));
  }

  #createTimeoutError(): Error {
    return new Error(
      `Timed out after ${String(this.#timeoutMs)}ms acquiring development-server state lock at "${this.#lockPath}".`,
    );
  }
}

function isLockContentionError(error: unknown): boolean {
  return isErrnoException(error, "EEXIST") || isErrnoException(error, "ENOTEMPTY");
}

function hashOwnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function readDevelopmentServerLockOwner(
  lockPath: string,
): Promise<DevelopmentServerLockOwner | undefined> {
  const raw = await readOptionalFile(join(lockPath, LOCK_OWNER_FILE_NAME));
  if (raw === undefined) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = developmentServerLockOwnerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function sameDevelopmentServerLockOwner(
  left: DevelopmentServerLockOwner | undefined,
  right: DevelopmentServerLockOwner,
): boolean {
  return left?.pid === right.pid && left.token === right.token;
}

function stateToOwner(state: PersistedDevelopmentServerState): DevelopmentServerOwner {
  return state.kind === "ready"
    ? { kind: "ready", pid: state.pid, url: state.url }
    : { kind: state.kind, pid: state.pid };
}

function parseDevServerState(raw: string): Result<PersistedDevelopmentServerState, unknown> {
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
  const parsed = legacyProcessIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
