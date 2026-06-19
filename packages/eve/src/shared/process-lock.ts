import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;

/** SQLite's `SQLITE_BUSY` result code: another connection holds the write lock. */
const SQLITE_BUSY_ERRCODE = 5;

/**
 * Releases a lock by rolling back its `BEGIN IMMEDIATE` transaction and closing
 * the connection. Closing alone frees the lock; the explicit `ROLLBACK` keeps
 * the on-disk database unchanged so the file stays a reusable empty lock.
 */
function releaseProcessLock(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

/**
 * Attempts to take an exclusive cross-process lock on `lockPath` without
 * waiting. Returns a release function on success, or `null` when another
 * process currently holds the lock.
 *
 * The lock is a SQLite `BEGIN IMMEDIATE` transaction: SQLite grants the write
 * lock to exactly one connection, and the OS drops it the instant the holding
 * process exits. That crash-safety is the whole point of using SQLite over an
 * `O_EXCL` lock file — there is no orphaned lock to detect and no stale-lock
 * TTL to tune. Callers that need "lock, or notice someone else already did the
 * work" (a registry-style startup race) poll this and inspect their own state
 * on `null`; callers that just want the lock use {@link acquireProcessLock}.
 *
 * The parent directory of `lockPath` must already exist.
 */
export function tryAcquireProcessLock(lockPath: string): (() => void) | null {
  const database = new DatabaseSync(lockPath, { timeout: 0 });

  try {
    database.exec("BEGIN IMMEDIATE");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseProcessLock(database);
    };
  } catch (error) {
    database.close();

    if (isSqliteBusyError(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Takes an exclusive cross-process lock on `lockPath`, waiting for a current
 * holder to release it. Returns a release function. Throws if the lock cannot
 * be acquired within `timeoutMs` (default {@link DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS}).
 *
 * See {@link tryAcquireProcessLock} for the locking mechanism and its
 * crash-safety guarantee. The parent directory of `lockPath` must already exist.
 */
export async function acquireProcessLock(
  lockPath: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let firstAttempt = true;

  for (;;) {
    if (!firstAttempt && Date.now() >= deadline) {
      throw new Error(`Timed out acquiring lock at "${lockPath}".`);
    }
    firstAttempt = false;

    const release = tryAcquireProcessLock(lockPath);

    if (release !== null) {
      return release;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out acquiring lock at "${lockPath}".`);
    }

    await delay(Math.min(LOCK_POLL_MS, remainingMs));
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_SQLITE_ERROR" &&
    "errcode" in error &&
    error.errcode === SQLITE_BUSY_ERRCODE
  );
}
