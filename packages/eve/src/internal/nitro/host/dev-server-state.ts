import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { isEveServerHealthy } from "#shared/eve-server-health.js";
import { err, ok, type Result } from "#shared/result.js";

// One record per project root, under `.eve/`. A live starting owner, or a live
// ready owner whose health route responds, blocks another claim. A TUI reads
// `url` from a healthy `ready` record to reattach without scanning ports.
const STATE_FILE_NAME = "dev-server.json";
// A sibling lock directory (atomic `mkdir`) serializes the read-decide-write
// critical section so two processes cannot both win the claim. State updates
// land via atomic rename, so readers never see a torn file.
const LOCK_DIR_NAME = "dev-server.lock";
const LOCK_POLL_MS = 50;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
// A lock older than this is assumed abandoned by a crashed claimer. Claims are
// near-instant, so the window is generous relative to the work it guards.
const STALE_LOCK_MS = 60_000;

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
const devServerStateSchema = z.discriminatedUnion("kind", [
  startingDevServerStateSchema,
  readyDevServerStateSchema,
]);

/**
 * The recorded owner of the dev server for a project root.
 *
 * `ownerToken` is minted once by the store and required to publish or release
 * the claim. A `starting` owner has bound no URL yet; only a `ready` owner can
 * be reattached to.
 */
export type DevServerState = Readonly<z.infer<typeof devServerStateSchema>>;

/** The result of atomically claiming a project root. */
export type DevServerClaim =
  | { readonly kind: "claimed"; readonly ownerToken: string }
  | { readonly kind: "occupied"; readonly state: DevServerState };

/** Why {@link DevServerStateStore.claim} could not inspect or persist state. */
export type DevServerClaimError = { readonly kind: "io"; readonly cause: unknown };

/** Why {@link DevServerStateStore.publish} could not publish the claimed URL. */
export type DevServerPublishError =
  | { readonly kind: "io"; readonly cause: unknown }
  | { readonly kind: "ownership-lost"; readonly pid: number | null };

/**
 * Returns whether a process with `pid` is currently running. This only proves
 * process liveness; ready dev-server records also require a successful health
 * request through {@link isDevelopmentServerStateActive}. `EPERM` counts as
 * alive because the process exists but belongs to another user.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error, "EPERM");
  }
}

/**
 * Returns whether a recorded owner still represents an active dev server.
 * Starting owners have no URL yet, so process liveness protects their claim.
 * Ready owners must keep both their process and Eve health route alive.
 */
export async function isDevelopmentServerStateActive(state: DevServerState): Promise<boolean> {
  if (!isProcessRunning(state.pid)) {
    return false;
  }

  return state.kind === "starting" ? true : await isEveServerHealthy(state.url);
}

/**
 * Owns the `.eve/dev-server.json` record for one project root: its schema,
 * validation, atomic persistence, and the cross-process locking that keeps
 * ownership claims race-free. The host orchestrator drives the lifecycle:
 * `claim` chooses between an active owner and a fresh claim, `publish` records
 * the claimed URL, and `release` relinquishes ownership.
 */
export class DevServerStateStore {
  readonly #stateDir: string;
  readonly #statePath: string;
  readonly #lockDir: string;

  constructor(appRoot: string) {
    this.#stateDir = join(appRoot, ".eve");
    this.#statePath = join(this.#stateDir, STATE_FILE_NAME);
    this.#lockDir = join(this.#stateDir, LOCK_DIR_NAME);
  }

  /**
   * Atomically returns the active owner or records a fresh starting claim.
   * Missing, malformed, dead, and unhealthy records are replaced.
   * If claiming fails, an active atomically written record is still returned.
   */
  async claim(pid: number): Promise<Result<DevServerClaim, DevServerClaimError>> {
    try {
      return await this.#withLock(async () => {
        const loaded = await this.#load();

        if (loaded.kind === "ok") {
          const isServerActive = await isDevelopmentServerStateActive(loaded.state);
          if (isServerActive) {
            return ok({ kind: "occupied", state: loaded.state });
          }
        }

        const ownerToken = randomUUID();
        await this.#writeAtomic({ kind: "starting", ownerToken, pid });
        return ok({ kind: "claimed", ownerToken });
      });
    } catch (cause) {
      const loaded = await this.#load();
      if (loaded.kind === "ok" && (await isDevelopmentServerStateActive(loaded.state))) {
        return ok({ kind: "occupied", state: loaded.state });
      }

      return err({ kind: "io", cause });
    }
  }

  /** Publishes the URL for a claim that is still owned by `ownerToken`. */
  async publish(input: {
    readonly ownerToken: string;
    readonly url: string;
  }): Promise<Result<void, DevServerPublishError>> {
    try {
      return await this.#withLock(async () => {
        const loaded = await this.#load();

        if (loaded.kind !== "ok" || loaded.state.ownerToken !== input.ownerToken) {
          return err({
            kind: "ownership-lost",
            pid: loaded.kind === "ok" ? loaded.state.pid : null,
          });
        }

        await this.#writeAtomic({
          kind: "ready",
          ownerToken: input.ownerToken,
          pid: loaded.state.pid,
          url: input.url,
        });
        return ok(undefined);
      });
    } catch (cause) {
      return err({ kind: "io", cause });
    }
  }

  /**
   * Removes the record, but only if it is still owned by `token`. A mismatched
   * or already-replaced record is left untouched so a process never deletes a
   * successor's claim. Best-effort: a failed release leaves a record that the
   * next claim reclaims once this pid exits.
   */
  async release(token: string): Promise<void> {
    try {
      await this.#withLock(async () => {
        const loaded = await this.#load();

        if (loaded.kind === "ok" && loaded.state.ownerToken === token) {
          await rm(this.#statePath, { force: true });
        }
      });
    } catch {
      // Intentionally swallowed; see method doc.
    }
  }

  async #load(): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "corrupt" }
    | { readonly kind: "ok"; readonly state: DevServerState }
  > {
    let raw: string;

    try {
      raw = await readFile(this.#statePath, "utf8");
    } catch (error) {
      return isErrnoException(error, "ENOENT") ? { kind: "absent" } : { kind: "corrupt" };
    }

    const state = parseDevServerState(raw);
    return state.ok ? { kind: "ok", state: state.value } : { kind: "corrupt" };
  }

  async #writeAtomic(state: DevServerState): Promise<void> {
    await mkdir(this.#stateDir, { recursive: true });
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    const validatedState = devServerStateSchema.parse(state);
    await writeFile(temporaryPath, `${JSON.stringify(validatedState)}\n`, "utf8");
    await rename(temporaryPath, this.#statePath);
  }

  async #withLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.#acquireLock();

    try {
      return await callback();
    } finally {
      await rm(this.#lockDir, { force: true, recursive: true }).catch(() => {});
    }
  }

  async #acquireLock(): Promise<void> {
    const startedAt = Date.now();

    for (;;) {
      await mkdir(this.#stateDir, { recursive: true });

      try {
        await mkdir(this.#lockDir);
        return;
      } catch (error) {
        if (!isErrnoException(error, "EEXIST")) {
          throw error;
        }

        await this.#waitForLock(startedAt);
      }
    }
  }

  async #waitForLock(startedAt: number): Promise<void> {
    const info = await stat(this.#lockDir).catch((error: unknown) => {
      if (isErrnoException(error, "ENOENT")) {
        return null;
      }
      throw error;
    });

    if (info === null) {
      return;
    }

    const now = Date.now();

    if (now - info.mtimeMs > STALE_LOCK_MS) {
      await rm(this.#lockDir, { force: true, recursive: true }).catch(() => {});
      return;
    }

    if (now - startedAt > LOCK_ACQUIRE_TIMEOUT_MS) {
      throw new Error(`Timed out acquiring dev-server state lock at "${this.#lockDir}".`);
    }

    await delay(LOCK_POLL_MS);
  }
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

function isHttpServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
