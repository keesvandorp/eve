import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { resolveEveDestinationPrefix } from "./server.js";

const tempRoots: string[] = [];

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill(): void;
  pid: number;
}

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = process.pid;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
  };
  return child;
}

describe("resolveEveDestinationPrefix", () => {
  afterEach(async () => {
    spawnMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(
      tempRoots.splice(0).map((root) =>
        rm(root, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("resolves the canonical state published by its child", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const destination = resolveEveDestinationPrefix({
      appRoot,
      phase: "phase-development-server",
      productionDestinationPrefix: "/internal/eve",
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    child.stdout.emit("data", Buffer.from("eve child started\n"));
    const state = new DevelopmentServerState({ appRoot });
    const claim = await state.claim();
    if (!claim.ok || claim.value.kind !== "claimed") {
      throw new Error("Expected the child to claim the test app root.");
    }
    await claim.value.claim.publish("http://127.0.0.1:33449");

    await expect(destination).resolves.toBe("http://127.0.0.1:33449");
    child.kill();
  });
});

async function createTempAppRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-next-server-"));
  tempRoots.push(root);
  await writeFile(join(root, "instructions.md"), "You are a test agent.\n");
  return root;
}
