import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireProcessLock, tryAcquireProcessLock } from "#shared/process-lock.js";

describe("process-lock", () => {
  let directory: string;
  let lockPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "eve-process-lock-"));
    lockPath = join(directory, "test.lock.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("grants the lock to one holder and refuses others until release", () => {
    const release = tryAcquireProcessLock(lockPath);
    expect(release).not.toBeNull();

    expect(tryAcquireProcessLock(lockPath)).toBeNull();

    release?.();

    const reacquired = tryAcquireProcessLock(lockPath);
    expect(reacquired).not.toBeNull();
    reacquired?.();
  });

  it("waits for the current holder to release before acquiring", async () => {
    const release = tryAcquireProcessLock(lockPath);
    expect(release).not.toBeNull();

    const order: string[] = [];
    const pending = acquireProcessLock(lockPath, { timeoutMs: 2_000 }).then((nextRelease) => {
      order.push("acquired");
      return nextRelease;
    });

    // Long enough for several poll attempts to fail while the lock is held.
    await delay(120);
    order.push("released");
    release?.();

    const nextRelease = await pending;
    expect(order).toEqual(["released", "acquired"]);
    nextRelease();
  });

  it("throws when the lock cannot be acquired within the timeout", async () => {
    const release = tryAcquireProcessLock(lockPath);
    expect(release).not.toBeNull();

    await expect(acquireProcessLock(lockPath, { timeoutMs: 100 })).rejects.toThrow(/Timed out/u);

    release?.();
  });

  it("does not contend across distinct lock paths", () => {
    const releaseA = tryAcquireProcessLock(join(directory, "a.lock.sqlite"));
    const releaseB = tryAcquireProcessLock(join(directory, "b.lock.sqlite"));

    expect(releaseA).not.toBeNull();
    expect(releaseB).not.toBeNull();

    releaseA?.();
    releaseB?.();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
