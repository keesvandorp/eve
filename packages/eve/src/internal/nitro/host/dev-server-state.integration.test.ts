import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystemTestHooks = vi.hoisted(() => {
  return {
    afterRename: async (
      _source: unknown,
      _destination: unknown,
      _error: unknown,
    ): Promise<void> => {},
    beforeRemove: async (_path: unknown): Promise<void> => {},
    beforeRename: async (_source: unknown, _destination: unknown): Promise<void> => {},
    reset() {
      this.afterRename = async () => {};
      this.beforeRemove = async () => {};
      this.beforeRename = async () => {};
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await filesystemTestHooks.beforeRename(args[0], args[1]);
      try {
        const result = await actual.rename(...args);
        await filesystemTestHooks.afterRename(args[0], args[1], undefined);
        return result;
      } catch (error) {
        await filesystemTestHooks.afterRename(args[0], args[1], error);
        throw error;
      }
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await filesystemTestHooks.beforeRemove(args[0]);
      return await actual.rm(...args);
    },
  };
});

import {
  type DevelopmentServerClaim,
  type DevelopmentServerClaimAttempt,
  DevelopmentServerState,
} from "#internal/nitro/host/dev-server-state.js";
import type { Result } from "#shared/result.js";

const DEAD_PID = 2_147_483_646;
const STATE_FILE_NAME = "dev-server-state.v1.json";
const LOCK_DIRECTORY_NAME = "dev-server-state.lock";

describe("DevelopmentServerState", () => {
  let appRoot: string;
  let store: DevelopmentServerState;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-dev-server-state-"));
    store = new DevelopmentServerState({ appRoot });
  });

  afterEach(async () => {
    filesystemTestHooks.reset();
    vi.unstubAllGlobals();
    await rm(appRoot, { force: true, recursive: true });
  });

  async function writeRawRecord(value: unknown): Promise<void> {
    await mkdir(join(appRoot, ".eve"), { recursive: true });
    await writeFile(
      join(appRoot, ".eve", STATE_FILE_NAME),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  }

  async function readRawRecord(): Promise<unknown> {
    return JSON.parse(await readFile(join(appRoot, ".eve", STATE_FILE_NAME), "utf8"));
  }

  function requireClaimed(
    result: Result<DevelopmentServerClaimAttempt, unknown>,
  ): DevelopmentServerClaim {
    if (!result.ok || result.value.kind !== "claimed") {
      throw new Error(`Expected a claimed result, received ${JSON.stringify(result)}.`);
    }
    return result.value.claim;
  }

  it("observes an absent root as vacant", async () => {
    await expect(store.inspect()).resolves.toEqual({
      ok: true,
      value: { kind: "vacant" },
    });
  });

  it("observes a live ready owner without exposing its claim token", async () => {
    const stateClaim = requireClaimed(await store.claim());
    await stateClaim.publish("http://127.0.0.1:2000/");

    await expect(store.inspect()).resolves.toEqual({
      ok: true,
      value: {
        kind: "ready",
        pid: process.pid,
        url: "http://127.0.0.1:2000/",
      },
    });
  });

  it("claims an absent record and persists its generated owner token", async () => {
    const claim = await store.claim();
    const stateClaim = requireClaimed(claim);
    const record = await readRawRecord();

    expect(record).toEqual({
      kind: "starting",
      ownerToken: expect.any(String),
      pid: process.pid,
    });
    expect(stateClaim.pid).toBe(process.pid);
  });

  it("publishes a ready URL for the current owner", async () => {
    const stateClaim = requireClaimed(await store.claim());

    await expect(stateClaim.publish("http://127.0.0.1:2000/")).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(await readRawRecord()).toMatchObject({
      kind: "ready",
      ownerToken: expect.any(String),
      pid: process.pid,
      url: "http://127.0.0.1:2000/",
    });
  });

  it("marks a ready owner as closing before release", async () => {
    const stateClaim = requireClaimed(await store.claim());
    await stateClaim.publish("http://127.0.0.1:2000/");

    await expect(stateClaim.markClosing()).resolves.toEqual({ ok: true, value: undefined });
    await expect(readRawRecord()).resolves.toMatchObject({
      kind: "closing",
      ownerToken: expect.any(String),
      pid: process.pid,
    });
    await expect(readFile(join(appRoot, ".eve", "dev-server.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(appRoot, ".eve", "dev-process.pid"), "utf8")).resolves.toBe(
      `${process.pid}\n`,
    );
  });

  it("does not publish a closing owner as ready again", async () => {
    const stateClaim = requireClaimed(await store.claim());
    await stateClaim.publish("http://127.0.0.1:2000/");
    await stateClaim.markClosing();

    await expect(stateClaim.publish("http://127.0.0.1:3000/")).resolves.toEqual({
      error: { from: "closing", kind: "invalid-transition", to: "ready" },
      ok: false,
    });
    await expect(readRawRecord()).resolves.toMatchObject({
      kind: "closing",
      ownerToken: expect.any(String),
      pid: process.pid,
    });
    await expect(readFile(join(appRoot, ".eve", "dev-server.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns an active starting owner instead of replacing it", async () => {
    requireClaimed(await store.claim());
    const second = await store.claim();

    expect(second).toEqual({
      ok: true,
      value: {
        kind: "occupied",
        owner: { kind: "starting", pid: process.pid },
      },
    });
  });

  it("serializes simultaneous claims so exactly one caller owns the root", async () => {
    const otherStore = new DevelopmentServerState({ appRoot });
    const [first, second] = await Promise.all([store.claim(), otherStore.claim()]);
    const results = [first, second];
    const claimed = results.find((result) => result.ok && result.value.kind === "claimed");
    const occupied = results.find((result) => result.ok && result.value.kind === "occupied");

    expect(claimed).toBeDefined();
    expect(occupied).toBeDefined();
    if (
      claimed === undefined ||
      !claimed.ok ||
      claimed.value.kind !== "claimed" ||
      occupied === undefined ||
      !occupied.ok ||
      occupied.value.kind !== "occupied"
    ) {
      throw new Error("Expected one claimed and one occupied result.");
    }
    expect(await readRawRecord()).toMatchObject({ ownerToken: expect.any(String) });
  });

  it("waits instead of retiring a lock owned by a live process", async () => {
    const lockPath = join(appRoot, ".eve", LOCK_DIRECTORY_NAME);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "live-generation" })}\n`,
      "utf8",
    );
    let settled = false;
    const claim = store.claim().finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);

    await rm(lockPath, { force: true, recursive: true });
    requireClaimed(await claim);
  });

  it("does not let a delayed stale-lock recoverer remove a replacement generation", async () => {
    const lockPath = join(appRoot, ".eve", LOCK_DIRECTORY_NAME);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: DEAD_PID, token: "dead-generation" })}\n`,
      "utf8",
    );
    const replacementInstalled = Promise.withResolvers<void>();
    const secondRetirementStarted = Promise.withResolvers<void>();
    let retirementAttempts = 0;
    let delayedRetirementRejected = false;
    filesystemTestHooks.beforeRename = async (source, destination) => {
      if (
        source !== lockPath ||
        typeof destination !== "string" ||
        !destination.startsWith(`${lockPath}.retired.`)
      ) {
        return;
      }

      retirementAttempts += 1;
      if (retirementAttempts === 1) {
        await secondRetirementStarted.promise;
      } else {
        secondRetirementStarted.resolve();
        await replacementInstalled.promise;
      }
    };
    filesystemTestHooks.afterRename = async (source, destination, error) => {
      if (
        error === undefined &&
        typeof source === "string" &&
        source.startsWith(`${lockPath}.pending.`) &&
        destination === lockPath &&
        retirementAttempts === 2
      ) {
        replacementInstalled.resolve();
      }
      if (
        error !== undefined &&
        source === lockPath &&
        typeof destination === "string" &&
        destination.startsWith(`${lockPath}.retired.`)
      ) {
        delayedRetirementRejected = true;
      }
    };

    const results = await Promise.all([
      store.claim(),
      new DevelopmentServerState({ appRoot }).claim(),
    ]);
    expect(results.filter((result) => result.ok && result.value.kind === "claimed")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.ok && result.value.kind === "occupied")).toHaveLength(
      1,
    );

    expect(delayedRetirementRejected).toBe(true);
    expect(
      (await readdir(join(appRoot, ".eve"))).filter((entry) =>
        entry.startsWith(`${LOCK_DIRECTORY_NAME}.retired.`),
      ),
    ).toHaveLength(1);
  });

  it("retries when an incumbent releases between rename failure and observation", async () => {
    const lockPath = join(appRoot, ".eve", LOCK_DIRECTORY_NAME);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "departing-generation" })}\n`,
      "utf8",
    );
    filesystemTestHooks.afterRename = async (source, destination, error) => {
      if (
        error !== undefined &&
        typeof source === "string" &&
        source.startsWith(`${lockPath}.pending.`) &&
        destination === lockPath
      ) {
        await rm(lockPath, { force: true, recursive: true });
      }
    };

    requireClaimed(await store.claim());
  });

  it("reports failure to relinquish the active lock after claiming", async () => {
    const lockPath = join(appRoot, ".eve", LOCK_DIRECTORY_NAME);
    filesystemTestHooks.beforeRename = async (source, destination) => {
      if (
        source === lockPath &&
        typeof destination === "string" &&
        destination.startsWith(`${lockPath}.released.`)
      ) {
        throw new Error("Injected active development-server lock release failure.");
      }
    };

    const claim = await store.claim();

    expect(claim).toMatchObject({
      error: {
        cause: new Error("Injected active development-server lock release failure."),
        kind: "io",
      },
      ok: false,
    });
  });

  it("preserves a claim when detached lock cleanup fails", async () => {
    const lockPath = join(appRoot, ".eve", LOCK_DIRECTORY_NAME);
    filesystemTestHooks.beforeRemove = async (path) => {
      if (typeof path === "string" && path.startsWith(`${lockPath}.released.`)) {
        throw new Error("Injected detached development-server lock cleanup failure.");
      }
    };

    const claim = requireClaimed(await store.claim());
    await expect(claim.publish("http://127.0.0.1:2000/")).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("reclaims a record owned by a dead process", async () => {
    await writeRawRecord({ kind: "starting", ownerToken: "stale", pid: DEAD_PID });

    requireClaimed(await store.claim());

    expect(await readRawRecord()).toMatchObject({
      kind: "starting",
      ownerToken: expect.not.stringMatching(/^stale$/u),
      pid: process.pid,
    });
  });

  it("returns a live non-loopback owner without probing its persisted URL", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const state = {
      kind: "ready",
      ownerToken: "incumbent",
      pid: process.pid,
      url: "http://192.168.1.20:2000/",
    };
    await writeRawRecord(state);

    expect(await store.claim()).toEqual({
      ok: true,
      value: {
        kind: "occupied",
        owner: { kind: "ready", pid: state.pid, url: state.url },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a live ready owner without using health as an ownership signal", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const state = {
      kind: "ready",
      ownerToken: "incumbent",
      pid: process.pid,
      url: "http://127.0.0.1:2000/",
    };
    await writeRawRecord(state);

    expect(await store.claim()).toEqual({
      ok: true,
      value: {
        kind: "occupied",
        owner: { kind: "ready", pid: state.pid, url: state.url },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a live legacy owner as occupied during the state-file transition", async () => {
    await mkdir(join(appRoot, ".eve"), { recursive: true });
    await writeFile(join(appRoot, ".eve", "dev-process.pid"), `${process.pid}\n`, "utf8");
    await writeFile(
      join(appRoot, ".eve", "dev-server.json"),
      `${JSON.stringify({
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        url: "http://127.0.0.1:2000/",
      })}\n`,
      "utf8",
    );

    await expect(store.claim()).resolves.toEqual({
      ok: true,
      value: {
        kind: "occupied",
        owner: {
          kind: "ready",
          pid: process.pid,
          url: "http://127.0.0.1:2000/",
        },
      },
    });
  });

  it.each(["not-a-pid", "-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1)])(
    "ignores an invalid legacy process marker (%s)",
    async (rawProcessId) => {
      await mkdir(join(appRoot, ".eve"), { recursive: true });
      await writeFile(join(appRoot, ".eve", "dev-process.pid"), `${rawProcessId}\n`, "utf8");

      requireClaimed(await store.claim());
    },
  );

  it("ignores legacy metadata when its process marker is absent", async () => {
    await mkdir(join(appRoot, ".eve"), { recursive: true });
    await writeFile(
      join(appRoot, ".eve", "dev-server.json"),
      JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:2000/" }),
      "utf8",
    );

    requireClaimed(await store.claim());
  });

  it("ignores legacy metadata when its process marker is dead", async () => {
    await mkdir(join(appRoot, ".eve"), { recursive: true });
    await writeFile(join(appRoot, ".eve", "dev-process.pid"), `${DEAD_PID}\n`, "utf8");
    await writeFile(
      join(appRoot, ".eve", "dev-server.json"),
      JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:2000/" }),
      "utf8",
    );

    requireClaimed(await store.claim());
  });

  it("publishes compatibility records for Eve versions from before the transition", async () => {
    const stateClaim = requireClaimed(await store.claim());
    const legacyProcessIdPath = join(appRoot, ".eve", "dev-process.pid");
    const legacyServerPath = join(appRoot, ".eve", "dev-server.json");

    await expect(readFile(legacyProcessIdPath, "utf8")).resolves.toBe(`${process.pid}\n`);

    await stateClaim.publish("http://127.0.0.1:2000/");
    await expect(readFile(legacyServerPath, "utf8")).resolves.toSatisfy((raw: string) => {
      expect(JSON.parse(raw)).toMatchObject({
        pid: process.pid,
        url: "http://127.0.0.1:2000/",
      });
      return true;
    });

    await stateClaim.release();
    await expect(readFile(legacyProcessIdPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(legacyServerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the versioned owner when an old server later removes compatibility files", async () => {
    await mkdir(join(appRoot, ".eve"), { recursive: true });
    await writeFile(join(appRoot, ".eve", "dev-process.pid"), `${DEAD_PID}\n`, "utf8");
    await writeFile(
      join(appRoot, ".eve", "dev-server.json"),
      `${JSON.stringify({ pid: DEAD_PID, url: "http://127.0.0.1:1000/" })}\n`,
      "utf8",
    );
    const stateClaim = requireClaimed(await store.claim());
    await stateClaim.publish("http://127.0.0.1:2000/");

    await Promise.all([
      rm(join(appRoot, ".eve", "dev-process.pid"), { force: true }),
      rm(join(appRoot, ".eve", "dev-server.json"), { force: true }),
    ]);

    await expect(store.inspect()).resolves.toEqual({
      ok: true,
      value: {
        kind: "ready",
        pid: process.pid,
        url: "http://127.0.0.1:2000/",
      },
    });
    await expect(readRawRecord()).resolves.toMatchObject({
      kind: "ready",
      ownerToken: expect.any(String),
      pid: process.pid,
      url: "http://127.0.0.1:2000/",
    });
  });

  it("fails closed when versioned state fails its persisted schema", async () => {
    for (const record of [
      { kind: "ready", ownerToken: "invalid", pid: process.pid, url: "ftp://localhost/x" },
      { kind: "starting", ownerToken: "invalid", pid: process.pid, unexpected: true },
      "{ not json",
    ]) {
      await writeRawRecord(record);
      const claim = await store.claim();

      expect(claim).toMatchObject({ error: { kind: "io" }, ok: false });
      expect(await readFile(join(appRoot, ".eve", STATE_FILE_NAME), "utf8")).toBe(
        typeof record === "string" ? record : JSON.stringify(record),
      );
    }
  });

  it("rejects publication after ownership is lost", async () => {
    const stateClaim = requireClaimed(await store.claim());
    await stateClaim.release();

    await expect(stateClaim.publish("http://127.0.0.1:2000/")).resolves.toEqual({
      ok: false,
      error: { kind: "ownership-lost", pid: null },
    });
  });

  it("preserves a successor record when publication loses ownership", async () => {
    const stateClaim = requireClaimed(await store.claim());
    const successor = {
      kind: "starting",
      ownerToken: "successor",
      pid: process.pid,
    };
    await writeRawRecord(successor);

    await expect(stateClaim.publish("http://127.0.0.1:2000/")).resolves.toEqual({
      error: { kind: "ownership-lost", pid: process.pid },
      ok: false,
    });
    await expect(readRawRecord()).resolves.toEqual(successor);
  });

  it("does not let an old claim release a successor", async () => {
    const stateClaim = requireClaimed(await store.claim());
    const successor = {
      kind: "starting",
      ownerToken: "successor",
      pid: process.pid,
    };
    await writeRawRecord(successor);

    await stateClaim.release();

    await expect(readRawRecord()).resolves.toEqual(successor);
  });

  it("releases the matching claim", async () => {
    const stateClaim = requireClaimed(await store.claim());

    await stateClaim.release();

    expect((await store.claim()).ok).toBe(true);
  });

  it("writes a single trailing-newline JSON record", async () => {
    await store.claim();

    const raw = await readFile(join(appRoot, ".eve", STATE_FILE_NAME), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
