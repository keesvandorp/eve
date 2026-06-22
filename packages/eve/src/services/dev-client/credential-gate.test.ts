import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";

import { createDevelopmentCredentialGate } from "./credential-gate.js";
import type { DevelopmentOidcTokenResolution } from "./request-headers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function verifiedTarget(host: string) {
  return await resolveTestVercelTarget({
    host,
    projectId: "prj_verified",
    projectName: "verified-project",
  });
}

function resolvedToken(token: string): DevelopmentOidcTokenResolution {
  return { kind: "resolved", token };
}

describe("createDevelopmentCredentialGate", () => {
  it("stays anonymous until an authoritative target is installed", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "ambient-bypass");
    const gate = createDevelopmentCredentialGate("https://verified.example.com/path");

    await expect(gate.resolveToken()).resolves.toBe("");
    await expect(gate.resolveBypassHeaders()).resolves.toEqual({});

    const target = await verifiedTarget("verified.example.com");
    gate.authorize({ target, resolveToken: async () => resolvedToken(" oidc-token ") });

    await expect(gate.resolveToken()).resolves.toBe("oidc-token");
    await expect(gate.resolveBypassHeaders()).resolves.toEqual({
      "x-vercel-protection-bypass": "ambient-bypass",
    });
  });

  it("rejects authority for a different origin without replacing current authority", async () => {
    const gate = createDevelopmentCredentialGate("https://verified.example.com");
    const target = await verifiedTarget("verified.example.com");
    const otherTarget = await verifiedTarget("other.example.com");
    gate.authorize({ target, resolveToken: async () => resolvedToken("first-token") });

    expect(() =>
      gate.authorize({
        target: otherTarget,
        resolveToken: async () => resolvedToken("other-token"),
      }),
    ).toThrow("does not match");
    await expect(gate.resolveToken()).resolves.toBe("first-token");
  });

  it("permits an automation bypass only after origin verification", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "verified-bypass");
    const gate = createDevelopmentCredentialGate("https://verified.example.com");
    await expect(gate.resolveBypassHeaders()).resolves.toEqual({});
    const failure = { kind: "invalid-claims", invalidClaims: ["project_id"] } as const;

    gate.authorize({
      target: await verifiedTarget("verified.example.com"),
      resolveToken: async () => failure,
    });

    await expect(gate.resolveToken()).resolves.toBe("");
    await expect(gate.resolveBypassHeaders()).resolves.toEqual({
      "x-vercel-protection-bypass": "verified-bypass",
    });
    expect(gate.lastTokenFailure()).toEqual(failure);
  });

  it("resolves the current token for every request", async () => {
    const gate = createDevelopmentCredentialGate("https://verified.example.com");
    const resolveToken = vi
      .fn<() => Promise<DevelopmentOidcTokenResolution>>()
      .mockResolvedValueOnce(resolvedToken(" first-token "))
      .mockResolvedValueOnce(resolvedToken("second-token"));
    gate.authorize({
      target: await verifiedTarget("verified.example.com"),
      resolveToken,
    });

    await expect(gate.resolveToken()).resolves.toBe("first-token");
    await expect(gate.resolveToken()).resolves.toBe("second-token");
    expect(resolveToken).toHaveBeenCalledTimes(2);
  });

  it("clears a reported failure after a later token refresh succeeds", async () => {
    const failure = { kind: "resolution-failed", message: "refresh failed" } as const;
    const gate = createDevelopmentCredentialGate("https://verified.example.com");
    const resolveToken = vi
      .fn<() => Promise<DevelopmentOidcTokenResolution>>()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(resolvedToken("fresh-token"));
    gate.authorize({
      target: await verifiedTarget("verified.example.com"),
      resolveToken,
    });

    await expect(gate.resolveToken()).resolves.toBe("");
    expect(gate.lastTokenFailure()).toEqual(failure);
    await expect(gate.resolveToken()).resolves.toBe("fresh-token");
    expect(gate.lastTokenFailure()).toBeUndefined();
  });
});
