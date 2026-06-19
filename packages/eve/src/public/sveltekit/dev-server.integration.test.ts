import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";

async function createTempAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-sveltekit-dev-server-"));
  await writeFile(join(appRoot, "instructions.md"), "You are a test agent.\n");
  return appRoot;
}

async function publishReadyServer(appRoot: string, origin: string): Promise<void> {
  const state = new DevelopmentServerState({ appRoot });
  const claim = await state.claim();
  if (!claim.ok || claim.value.kind !== "claimed") {
    throw new Error("Expected to claim the test app root.");
  }
  const published = await claim.value.claim.publish(origin);
  if (!published.ok) {
    throw new Error("Expected to publish the test development server.");
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete process.env[EVE_BASE_URL_ENV];
});

describe("resolveSharedEveDevServer", () => {
  it("reuses a healthy registered server instead of spawning", async () => {
    const appRoot = await createTempAppRoot();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await publishReadyServer(appRoot, "http://127.0.0.1:49152");

    try {
      const handle = await resolveSharedEveDevServer(appRoot);

      expect(handle).toEqual({ origin: "http://127.0.0.1:49152" });
      expect(handle.process).toBeUndefined();
      expect(process.env[EVE_BASE_URL_ENV]).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49152/eve/v1/health", {
        signal: expect.any(AbortSignal),
      });
    } finally {
      await rm(appRoot, { force: true, recursive: true });
    }
  });
});
