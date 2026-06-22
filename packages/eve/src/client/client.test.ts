import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import type { AgentInfoResult } from "#client/types.js";

const AGENT_INFO: AgentInfoResult = {
  agent: {
    agentRoot: "/tmp/weather-agent/agent",
    appRoot: "/tmp/weather-agent",
    model: { id: "openai/gpt-5.5" },
    name: "Weather Agent",
  },
  capabilities: { devRoutes: true },
  channels: { authored: [], available: [], disabledFramework: [], framework: [] },
  connections: [],
  diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
  hooks: [],
  instructions: { dynamic: [], static: null },
  kind: "eve-agent-info",
  mode: "development",
  sandbox: null,
  schedules: [],
  skills: { dynamic: [], static: [] },
  subagents: { local: [], total: 0 },
  tools: {
    authored: [],
    available: [],
    disabledFramework: [],
    dynamic: [],
    framework: [],
    reserved: [],
  },
  version: 1,
  workflow: { enabled: false, toolName: "Workflow" },
  workspace: { resourceRoot: null, rootEntries: [] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Client request policy", () => {
  it("enforces its redirect policy for info, health, raw fetch, and sessions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(AGENT_INFO))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "session_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({ host: "https://eve.test", redirect: "manual" });
    const signal = new AbortController().signal;

    await client.info({ signal });
    await client.health();
    await client.fetch("/custom", { redirect: "follow" });
    await (await client.session().send("hello")).result();

    expect(fetchMock.mock.calls).toHaveLength(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it("expands vercelOidc auth into the bearer and trusted-oidc headers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(AGENT_INFO));
    const client = new Client({
      host: "https://eve.test",
      auth: { vercelOidc: { token: () => Promise.resolve("oidc-tok") } },
    });

    await client.info();

    const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe("Bearer oidc-tok");
    expect(sent.get("x-vercel-trusted-oidc-idp-token")).toBe("oidc-tok");
  });

  it("accepts a tool whose undefined output schema was omitted during JSON serialization", async () => {
    const toolWithoutOutputSchema = {
      description: "Search the web",
      hasAuth: false,
      hasExecute: false,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      logicalPath: "eve:framework/web-search",
      name: "web_search",
      origin: "framework",
      replacesFrameworkTool: false,
      requiresApproval: false,
      sourceKind: "module",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...AGENT_INFO,
        tools: {
          ...AGENT_INFO.tools,
          available: [toolWithoutOutputSchema],
        },
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    const info = await client.info();

    expect(info.tools.available[0]).toMatchObject({
      hasOutputSchema: false,
      name: "web_search",
    });
    expect(info.tools.available[0]).not.toHaveProperty("outputSchema");
  });

  it("rejects a non-Eve response from the agent info route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ kind: "eve-agent-info", version: 1 }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(SyntaxError);
  });

  it("rejects an incomplete agent info payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        agent: { model: { id: "openai/gpt-5.5" } },
        diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
        kind: "eve-agent-info",
        version: 1,
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(SyntaxError);
  });

  it.each([null, { kind: "gateway", connected: true }, { kind: "external" }])(
    "rejects an invalid model endpoint from the agent info route",
    async (endpoint) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          ...AGENT_INFO,
          agent: {
            ...AGENT_INFO.agent,
            model: { ...AGENT_INFO.agent.model, endpoint },
          },
        }),
      );
      const client = new Client({ host: "https://eve.test" });

      await expect(client.info()).rejects.toThrow(SyntaxError);
    },
  );

  it("aborts while dynamic request headers are still resolving", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new Client({
      host: "https://eve.test",
      headers: () => new Promise<Readonly<Record<string, string>>>(() => {}),
    });
    const abort = new AbortController();
    const reason = new Error("cancelled");

    const info = client.info({ signal: abort.signal });
    abort.abort(reason);

    await expect(info).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a session send while dynamic request headers are still resolving", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new Client({
      host: "https://eve.test",
      headers: () => new Promise<Readonly<Record<string, string>>>(() => {}),
    });
    const abort = new AbortController();
    const reason = new Error("cancelled");

    const send = client.session().send({
      message: "hello",
      signal: abort.signal,
    });
    abort.abort(reason);

    await expect(send).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
