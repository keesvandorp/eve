import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";

// Keep the dev TUI's glyph set deterministic across CI hosts so the
// screen assertions below remain stable.
process.env.EVE_TUI_UNICODE = "1";

const scenarioApp = useScenarioApp();
const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;
const DEV_SERVER_ATTACHMENT_PROBE_SOURCE = `import { runCli } from "./node_modules/eve/dist/src/cli/run.js";

Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

let attachment;
let outcome;

try {
  await runCli(
    ["dev", ...process.argv.slice(2)],
    {
      error: (message) => console.error(message),
      log: (message) => console.log(message),
    },
    {
      runDevelopmentTui: async (input) => {
        attachment = {
          appRoot: input.target.kind === "local" ? input.target.workspaceRoot : undefined,
          serverUrl: input.target.serverUrl,
        };
      },
    },
  );
  outcome = { attachment, ok: true };
} catch (error) {
  outcome = { error: error instanceof Error ? error.message : String(error), ok: false };
}

process.stdout.write(\`EVE_ATTACHMENT_PROBE \${JSON.stringify(outcome)}\\n\`, () => {
  process.exit(outcome.ok ? 0 : 1);
});
`;
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  dependencies: {
    ...WEATHER_AGENT_DESCRIPTOR.dependencies,
    microsandbox: "0.5.5",
  },
  files: {
    ...Object.fromEntries(
      Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
        ([path]) => !path.startsWith("agent/channels/"),
      ),
    ),
    "probe-dev-attachment.mjs": DEV_SERVER_ATTACHMENT_PROBE_SOURCE,
  },
};

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

interface AttachmentProbeResult {
  readonly attachment?: {
    readonly appRoot?: string;
    readonly serverUrl: string;
  };
  readonly error?: string;
  readonly ok: boolean;
}

function parseAttachmentProbeResult(raw: string): AttachmentProbeResult {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    throw new Error("Attachment probe returned an invalid result.");
  }

  const ok = parsed.ok;
  if (typeof ok !== "boolean") {
    throw new Error("Attachment probe result omitted its boolean status.");
  }

  const result: { attachment?: AttachmentProbeResult["attachment"]; error?: string; ok: boolean } =
    {
      ok,
    };
  if ("error" in parsed && typeof parsed.error === "string") {
    result.error = parsed.error;
  }
  if (
    "attachment" in parsed &&
    typeof parsed.attachment === "object" &&
    parsed.attachment !== null
  ) {
    const attachment = parsed.attachment;
    if (!("serverUrl" in attachment) || typeof attachment.serverUrl !== "string") {
      throw new Error("Attachment probe result omitted its server URL.");
    }
    result.attachment = {
      appRoot:
        "appRoot" in attachment && typeof attachment.appRoot === "string"
          ? attachment.appRoot
          : undefined,
      serverUrl: attachment.serverUrl,
    };
  }
  return result;
}

async function readStateProcessId(path: string): Promise<number> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) {
    throw new Error(`Dev-server state at ${path} omitted its process id.`);
  }
  if (typeof parsed.pid !== "number") {
    throw new Error(`Dev-server state at ${path} has an invalid process id.`);
  }
  return parsed.pid;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

function hasKnownDevBundlingFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevBundlingFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known generated dev bundle import failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // Activate the deterministic mock-model adapter in the spawned dev
        // server so the streamed turn completes without model credentials.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await waitForServerUrl({
    child,
    getOutput: () => ({
      stderr,
      stdout,
    }),
  });

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
    url,
  };
}

async function runAttachmentProbe(
  appRoot: string,
  options: {
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<AttachmentProbeResult> {
  const environment = { ...process.env };
  delete environment.PORT;
  Object.assign(environment, options.env);
  const child = spawn(
    process.execPath,
    [join(appRoot, "probe-dev-attachment.mjs"), ...(options.args ?? [])],
    {
      cwd: join(appRoot, "agent"),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for attachment probe.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 120_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  const match = /EVE_ATTACHMENT_PROBE (\{.*\})/u.exec(stripAnsi(stdout));
  if (match?.[1] === undefined) {
    throw new Error(`Attachment probe returned no result.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return parseAttachmentProbeResult(match[1]);
}

describe("eve dev server", () => {
  it(
    "reconnects by app root, honors endpoint opt-outs, and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const otherApp = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        const statePath = join(app.appRoot, ".eve", "dev-server-state.v1.json");
        const processIdBeforeAttachment = await readStateProcessId(statePath);
        const attachment = await runAttachmentProbe(app.appRoot);

        expect(attachment).toEqual({
          attachment: {
            appRoot: await realpath(app.appRoot),
            serverUrl: server.url,
          },
          ok: true,
        });
        expect(await readStateProcessId(statePath)).toBe(processIdBeforeAttachment);
        await expect(fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url))).resolves.toMatchObject({
          status: 200,
        });

        for (const args of [
          ["--host", "127.0.0.1"],
          ["--port", "0"],
        ] as const) {
          const rejectedAttachment = await runAttachmentProbe(app.appRoot, { args });
          expect(rejectedAttachment.ok).toBe(false);
          expect(rejectedAttachment.error).toContain("A dev server is already running");
        }

        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);

        const appEnvironmentPath = join(app.appRoot, ".env.local");
        await writeFile(appEnvironmentPath, `PORT=${new URL(server.url).port}\n`, "utf8");
        try {
          const rejectedAttachment = await runAttachmentProbe(app.appRoot);
          expect(rejectedAttachment.ok).toBe(false);
          expect(rejectedAttachment.error).toContain("A dev server is already running");
        } finally {
          await rm(appEnvironmentPath, { force: true });
        }

        const otherServer = await startEveDev(otherApp.appRoot);
        try {
          expect(otherServer.url).not.toBe(server.url);
          expect(
            await readStateProcessId(join(otherApp.appRoot, ".eve", "dev-server-state.v1.json")),
          ).not.toBe(processIdBeforeAttachment);
          await expect(
            fetch(new URL(EVE_HEALTH_ROUTE_PATH, otherServer.url)),
          ).resolves.toMatchObject({ status: 200 });
          const otherAttachment = await runAttachmentProbe(otherApp.appRoot);
          expect(otherAttachment).toEqual({
            attachment: {
              appRoot: await realpath(otherApp.appRoot),
              serverUrl: otherServer.url,
            },
            ok: true,
          });
          expect(await readStateProcessId(statePath)).toBe(processIdBeforeAttachment);
          await expect(fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url))).resolves.toMatchObject({
            status: 200,
          });
        } finally {
          await otherServer.stop();
        }
        await wait(1_000);

        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevBundlingFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
