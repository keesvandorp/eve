import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DevServerClaim,
  type DevServerState,
  DevServerStateStore,
  isDevelopmentServerStateActive,
} from "#internal/nitro/host/dev-server-state.js";
import type { Result } from "#shared/result.js";

const DEAD_PID = 2_147_483_646;

describe("DevServerStateStore", () => {
  let appRoot: string;
  let store: DevServerStateStore;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-dev-server-state-"));
    store = new DevServerStateStore(appRoot);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(appRoot, { force: true, recursive: true });
  });

  async function writeRawRecord(value: unknown): Promise<void> {
    await mkdir(join(appRoot, ".eve"), { recursive: true });
    await writeFile(
      join(appRoot, ".eve", "dev-server.json"),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  }

  async function readRawRecord(): Promise<unknown> {
    return JSON.parse(await readFile(join(appRoot, ".eve", "dev-server.json"), "utf8"));
  }

  function requireClaimed(result: Result<DevServerClaim, unknown>): string {
    if (!result.ok || result.value.kind !== "claimed") {
      throw new Error(`Expected a claimed result, received ${JSON.stringify(result)}.`);
    }
    return result.value.ownerToken;
  }

  it("claims an absent record and persists its generated owner token", async () => {
    const claim = await store.claim(process.pid);
    const ownerToken = requireClaimed(claim);

    expect(await readRawRecord()).toEqual({
      kind: "starting",
      ownerToken,
      pid: process.pid,
    });
  });

  it("publishes a ready URL for the current owner", async () => {
    const ownerToken = requireClaimed(await store.claim(process.pid));

    await expect(store.publish({ ownerToken, url: "http://127.0.0.1:2000/" })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(await readRawRecord()).toEqual({
      kind: "ready",
      ownerToken,
      pid: process.pid,
      url: "http://127.0.0.1:2000/",
    });
  });

  it("returns an active starting owner instead of replacing it", async () => {
    const ownerToken = requireClaimed(await store.claim(process.pid));
    const second = await store.claim(process.pid);

    expect(second).toEqual({
      ok: true,
      value: {
        kind: "occupied",
        state: { kind: "starting", ownerToken, pid: process.pid },
      },
    });
  });

  it("serializes simultaneous claims so exactly one caller owns the root", async () => {
    const [first, second] = await Promise.all([store.claim(process.pid), store.claim(process.pid)]);
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
    expect(occupied.value.state.ownerToken).toBe(claimed.value.ownerToken);
  });

  it("reclaims a record owned by a dead process", async () => {
    await writeRawRecord({ kind: "starting", ownerToken: "stale", pid: DEAD_PID });

    const ownerToken = requireClaimed(await store.claim(process.pid));

    expect(ownerToken).not.toBe("stale");
  });

  it("returns a healthy non-loopback server as the active owner", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const state: DevServerState = {
      kind: "ready",
      ownerToken: "incumbent",
      pid: process.pid,
      url: "http://192.168.1.20:2000/",
    };
    await writeRawRecord(state);

    expect(await store.claim(process.pid)).toEqual({
      ok: true,
      value: { kind: "occupied", state },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reclaims a ready record after one failed health request", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await writeRawRecord({
      kind: "ready",
      ownerToken: "incumbent",
      pid: process.pid,
      url: "http://127.0.0.1:2000/",
    });

    expect((await store.claim(process.pid)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not treat a live process as active when its ready server is unhealthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const state: DevServerState = {
      kind: "ready",
      ownerToken: "incumbent",
      pid: process.pid,
      url: "http://127.0.0.1:2000/",
    };

    expect(await isDevelopmentServerStateActive(state)).toBe(false);
  });

  it("reclaims records that fail the strict persisted schema", async () => {
    for (const record of [
      { kind: "ready", ownerToken: "invalid", pid: process.pid, url: "ftp://localhost/x" },
      { kind: "starting", ownerToken: "invalid", pid: process.pid, unexpected: true },
      "{ not json",
    ]) {
      await writeRawRecord(record);
      const ownerToken = requireClaimed(await store.claim(process.pid));
      await store.release(ownerToken);
    }
  });

  it("rejects publication after ownership is lost", async () => {
    await expect(
      store.publish({ ownerToken: "missing", url: "http://127.0.0.1:2000/" }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "ownership-lost", pid: null },
    });
  });

  it("releases only the matching owner token", async () => {
    const ownerToken = requireClaimed(await store.claim(process.pid));

    await store.release("someone-else");
    expect(await store.claim(process.pid)).toMatchObject({
      ok: true,
      value: { kind: "occupied" },
    });

    await store.release(ownerToken);
    expect((await store.claim(process.pid)).ok).toBe(true);
  });

  it("writes a single trailing-newline JSON record", async () => {
    await store.claim(process.pid);

    const raw = await readFile(join(appRoot, ".eve", "dev-server.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
