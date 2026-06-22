import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";

import {
  EVE_BASE_URL_ENV,
  resolveSharedDevelopmentServer,
} from "./resolve-shared-development-server.js";

const tempRoots: string[] = [];

interface MockChildProcess extends EventEmitter {
  stderr: EventEmitter;
  stdout: EventEmitter;
  killed: boolean;
  pid: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.pid = pid;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  return child;
}

async function createTempAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-shared-dev-server-"));
  tempRoots.push(appRoot);
  await writeFile(join(appRoot, "instructions.md"), "You are a test agent.\n");
  return appRoot;
}

async function claimState(appRoot: string) {
  const state = new DevelopmentServerState({ appRoot });
  const claimed = await state.claim();
  if (!claimed.ok || claimed.value.kind !== "claimed") {
    throw new Error("Expected to claim the test app root.");
  }
  return claimed.value.claim;
}

afterEach(async () => {
  spawnMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env[EVE_BASE_URL_ENV];
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("resolveSharedDevelopmentServer", () => {
  it("waits for a live starting owner instead of spawning", async () => {
    const appRoot = await createTempAppRoot();
    const claim = await claimState(appRoot);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const resolution = resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 });
    await delay(150);
    expect(spawnMock).not.toHaveBeenCalled();

    await claim.publish("http://127.0.0.1:49152");

    await expect(resolution).resolves.toEqual({ origin: "http://127.0.0.1:49152" });
  });

  it("does not replace an unhealthy live owner", async () => {
    const appRoot = await createTempAppRoot();
    const claim = await claimState(appRoot);
    await claim.publish("http://127.0.0.1:49152");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    await expect(resolveSharedDevelopmentServer({ appRoot, timeoutMs: 150 })).rejects.toThrow(
      /Timed out after 150ms/u,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(new DevelopmentServerState({ appRoot }).inspect()).resolves.toMatchObject({
      ok: true,
      value: { kind: "ready", pid: process.pid },
    });
  });

  it("reports a failed candidate when no competing owner claimed", async () => {
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess(2_147_483_646);
    spawnMock.mockReturnValue(child);

    const resolution = resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("exit", 1, null);

    await expect(resolution).rejects.toThrow(/failed before publishing ready state \(exit code 1/u);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("uses the winning owner when its candidate child loses the claim", async () => {
    const appRoot = await createTempAppRoot();
    const losingChild = createMockChildProcess(2_147_483_646);
    let terminationRequested = false;
    losingChild.kill = () => {
      terminationRequested = true;
      losingChild.killed = true;
      return true;
    };
    spawnMock.mockReturnValue(losingChild);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const resolution = resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

    const winner = await claimState(appRoot);
    await winner.publish("http://127.0.0.1:49152");

    let resolved = false;
    resolution.then(
      () => {
        resolved = true;
      },
      () => {
        resolved = true;
      },
    );
    await vi.waitFor(() => expect(terminationRequested).toBe(true));
    expect(resolved).toBe(false);
    losingChild.emit("exit", null, "SIGTERM");

    await expect(resolution).resolves.toEqual({ origin: "http://127.0.0.1:49152" });
  });

  it("retries when its candidate loses to an owner that later exits", async () => {
    const appRoot = await createTempAppRoot();
    const losingChild = createMockChildProcess(2_147_483_646);
    const winningChild = createMockChildProcess(process.pid);
    spawnMock.mockReturnValueOnce(losingChild).mockReturnValueOnce(winningChild);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const resolution = resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    const transientWinner = await claimState(appRoot);
    losingChild.emit("exit", 1, null);
    await delay(150);
    await transientWinner.release();

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const finalWinner = await claimState(appRoot);
    await finalWinner.publish("http://127.0.0.1:49152");

    const handle = await resolution;
    expect(handle).toEqual({
      close: expect.any(Function),
      origin: "http://127.0.0.1:49152",
      process: winningChild,
    });
    await handle.close?.();
  });

  it("returns its child when that child publishes the winning claim", async () => {
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess(process.pid);
    spawnMock.mockReturnValue(child);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const resolution = resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

    const claim = await claimState(appRoot);
    await claim.publish("http://127.0.0.1:49152");

    const handle = await resolution;
    expect(handle).toEqual({
      close: expect.any(Function),
      origin: "http://127.0.0.1:49152",
      process: child,
    });
    await handle.close?.();
  });

  it("keeps configured environment separate while resolving different app roots", async () => {
    const firstAppRoot = await createTempAppRoot();
    const secondAppRoot = await createTempAppRoot();
    const firstClaim = await claimState(firstAppRoot);
    const secondClaim = await claimState(secondAppRoot);
    await firstClaim.publish("http://127.0.0.1:49152");
    await secondClaim.publish("http://127.0.0.1:49153");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    await expect(
      resolveSharedDevelopmentServer({ appRoot: firstAppRoot, timeoutMs: 2_000 }),
    ).resolves.toEqual({ origin: "http://127.0.0.1:49152" });
    await expect(
      resolveSharedDevelopmentServer({ appRoot: secondAppRoot, timeoutMs: 2_000 }),
    ).resolves.toEqual({ origin: "http://127.0.0.1:49153" });
    expect(process.env[EVE_BASE_URL_ENV]).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
