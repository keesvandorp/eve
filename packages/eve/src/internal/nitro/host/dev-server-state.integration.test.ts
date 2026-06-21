import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("waits for the process-safe lock instead of taking over a live holder", async () => {
    const lockPath = join(appRoot, ".eve", LOCK_DIRECTORY_NAME);
    await mkdir(lockPath, { recursive: true });
    let claimSettled = false;
    const claimPromise = store.claim().finally(() => {
      claimSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(claimSettled).toBe(false);

    await rm(lockPath, { force: true, recursive: true });

    requireClaimed(await claimPromise);
  });

  it("recovers a stale lock directory", async () => {
    const lockPath = join(appRoot, ".eve", LOCK_DIRECTORY_NAME);
    await mkdir(lockPath, { recursive: true });
    const staleTimestamp = new Date(Date.now() - 120_000);
    await utimes(lockPath, staleTimestamp, staleTimestamp);

    requireClaimed(await store.claim());
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
