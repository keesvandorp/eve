import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveDiscoveryProject } from "#discover/project.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import {
  DevelopmentServerState,
  type DevelopmentServerObservation,
} from "#internal/nitro/host/dev-server-state.js";
import { isEveServerHealthy } from "#shared/eve-server-health.js";
import { isLocalDevelopmentServerUrl } from "#shared/network-address.js";

export const EVE_BASE_URL_ENV = "EVE_BASE_URL";

const DEVELOPMENT_SERVER_POLL_MS = 100;
const DEVELOPMENT_SERVER_SHUTDOWN_GRACE_MS = 1_000;
const MAX_CHILD_OUTPUT_TAIL_LENGTH = 16_384;

export interface SharedDevelopmentServerHandle {
  readonly close?: () => Promise<void>;
  readonly origin: string;
  readonly process?: ChildProcess;
}

type ChildProcessOutcome =
  | { readonly kind: "error"; readonly error: Error }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

interface DevelopmentServerCandidate {
  readonly process: ChildProcess;
  settled: Promise<void>;
  outcome: ChildProcessOutcome | undefined;
  stderrTail: string;
  stdoutTail: string;
}

/**
 * Resolves one root-scoped development server for a framework adapter.
 *
 * The framework parent never claims ownership. Its child runs the normal
 * `eve dev` path and claims through {@link DevelopmentServerState}; competing
 * children therefore converge on the same canonical owner without another
 * registry or startup lock.
 */
export async function resolveSharedDevelopmentServer(input: {
  readonly appRoot: string;
  readonly timeoutMs: number;
}): Promise<SharedDevelopmentServerHandle> {
  const deadline = Date.now() + input.timeoutMs;
  const project = await waitWithinDeadline(resolveDiscoveryProject(input.appRoot), deadline, () =>
    createResolutionTimeout({
      appRoot: input.appRoot,
      candidate: undefined,
      observation: { kind: "vacant" },
      timeoutMs: input.timeoutMs,
    }),
  );
  const state = new DevelopmentServerState(project);
  let candidate: DevelopmentServerCandidate | undefined;
  let observation: DevelopmentServerObservation = { kind: "vacant" };
  let observedCompetingOwner = false;

  try {
    for (;;) {
      assertBeforeDeadline({
        appRoot: project.appRoot,
        candidate,
        observation,
        timeoutMs: input.timeoutMs,
        deadline,
      });

      const inspected = await waitWithinDeadline(
        state.inspect({ timeoutMs: remainingTime(deadline) }),
        deadline,
        () =>
          createResolutionTimeout({
            appRoot: project.appRoot,
            candidate,
            observation,
            timeoutMs: input.timeoutMs,
          }),
      );
      if (!inspected.ok) {
        throw new Error(`Could not inspect development-server state for "${project.appRoot}".`, {
          cause: inspected.error.cause,
        });
      }
      observation = inspected.value;
      assertBeforeDeadline({
        appRoot: project.appRoot,
        candidate,
        observation,
        timeoutMs: input.timeoutMs,
        deadline,
      });

      if (
        observation.kind !== "vacant" &&
        candidate !== undefined &&
        observation.pid !== candidate.process.pid
      ) {
        observedCompetingOwner = true;
      }

      if (observation.kind === "vacant") {
        if (candidate?.outcome !== undefined) {
          if (!observedCompetingOwner) {
            throw createCandidateFailure(candidate, project.appRoot);
          }
          candidate = undefined;
          observedCompetingOwner = false;
        }
        candidate ??= spawnDevelopmentServerCandidate(project.appRoot);
      } else if (observation.kind === "ready") {
        if (!isLocalDevelopmentServerUrl(observation.url)) {
          throw new Error(
            `Development server ${observation.pid} for "${project.appRoot}" published a non-local URL (${observation.url}); refusing to attach.`,
          );
        }

        const remainingMs = remainingTime(deadline);
        const healthy = await waitWithinDeadline(
          isEveServerHealthy(observation.url, {
            timeoutMs: Math.min(remainingMs, 1_000),
          }),
          deadline,
          () =>
            createResolutionTimeout({
              appRoot: project.appRoot,
              candidate,
              observation,
              timeoutMs: input.timeoutMs,
            }),
        );
        if (healthy) {
          assertBeforeDeadline({
            appRoot: project.appRoot,
            candidate,
            observation,
            timeoutMs: input.timeoutMs,
            deadline,
          });
          const ownsCandidate = candidate?.process.pid === observation.pid;
          if (ownsCandidate && candidate?.outcome !== undefined) {
            await waitForStateChange(candidate, deadline);
            continue;
          }
          if (candidate !== undefined && !ownsCandidate) {
            await terminateCandidate(candidate);
          }

          return ownsCandidate && candidate !== undefined
            ? createOwnedDevelopmentServerHandle(observation.url, candidate)
            : { origin: observation.url };
        }
      }

      await waitForStateChange(candidate, deadline);
    }
  } catch (error) {
    if (candidate !== undefined) {
      try {
        await terminateCandidate(candidate);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to resolve and clean up the development-server candidate for "${project.appRoot}".`,
        );
      }
    }
    throw error;
  }
}

function spawnDevelopmentServerCandidate(appRoot: string): DevelopmentServerCandidate {
  const child = spawn(
    process.execPath,
    [join(resolvePackageRoot(), "bin", "eve.js"), "dev", "--no-ui", "--port", "0"],
    {
      cwd: appRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const candidate: DevelopmentServerCandidate = {
    outcome: undefined,
    process: child,
    settled: Promise.resolve(),
    stderrTail: "",
    stdoutTail: "",
  };
  candidate.settled = new Promise((resolvePromise) => {
    const settle = (outcome: ChildProcessOutcome) => {
      if (candidate.outcome !== undefined) {
        return;
      }
      candidate.outcome = outcome;
      resolvePromise();
    };

    child.once("error", (error) => settle({ error, kind: "error" }));
    child.once("exit", (code, signal) => settle({ code, kind: "exit", signal }));
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    candidate.stdoutTail = appendOutputTail(candidate.stdoutTail, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    candidate.stderrTail = appendOutputTail(candidate.stderrTail, chunk);
  });
  return candidate;
}

function appendOutputTail(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_CHILD_OUTPUT_TAIL_LENGTH);
}

async function waitForStateChange(
  candidate: DevelopmentServerCandidate | undefined,
  deadline: number,
): Promise<void> {
  const waitMs = Math.min(DEVELOPMENT_SERVER_POLL_MS, remainingTime(deadline));
  if (candidate === undefined || candidate.outcome !== undefined) {
    await delay(waitMs);
    return;
  }

  await Promise.race([delay(waitMs), candidate.settled]);
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function assertBeforeDeadline(input: {
  readonly appRoot: string;
  readonly candidate: DevelopmentServerCandidate | undefined;
  readonly deadline: number;
  readonly observation: DevelopmentServerObservation;
  readonly timeoutMs: number;
}): void {
  if (Date.now() < input.deadline) {
    return;
  }

  throw createResolutionTimeout(input);
}

function createResolutionTimeout(input: {
  readonly appRoot: string;
  readonly candidate: DevelopmentServerCandidate | undefined;
  readonly observation: DevelopmentServerObservation;
  readonly timeoutMs: number;
}): Error {
  const owner =
    input.observation.kind === "vacant"
      ? "no live owner"
      : `${input.observation.kind} owner ${input.observation.pid}`;
  const candidateStatus =
    input.candidate === undefined
      ? "no child was spawned"
      : input.candidate.outcome === undefined
        ? `child ${String(input.candidate.process.pid)} is still running`
        : "the spawned child exited before a reusable server became ready";
  return new Error(
    `Timed out after ${input.timeoutMs}ms resolving the development server for "${input.appRoot}" (${owner}; ${candidateStatus}).`,
  );
}

async function waitWithinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  createTimeoutError: () => Error,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw createTimeoutError();
  }

  const timeoutController = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(remainingMs, undefined, { signal: timeoutController.signal }).then(() => {
        throw createTimeoutError();
      }),
    ]);
  } finally {
    timeoutController.abort();
  }
}

function createCandidateFailure(candidate: DevelopmentServerCandidate, appRoot: string): Error {
  const outcome = candidate.outcome;
  if (outcome === undefined) {
    return new Error(`Development-server child for "${appRoot}" did not publish ready state.`);
  }

  const summary =
    outcome.kind === "error"
      ? outcome.error.message
      : `exit code ${String(outcome.code)}, signal ${String(outcome.signal)}`;
  const output = [
    candidate.stdoutTail.length > 0 ? `stdout:\n${candidate.stdoutTail}` : undefined,
    candidate.stderrTail.length > 0 ? `stderr:\n${candidate.stderrTail}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  return new Error(
    `Development-server child for "${appRoot}" failed before publishing ready state (${summary}).${output.length > 0 ? `\n\n${output}` : ""}`,
    outcome.kind === "error" ? { cause: outcome.error } : undefined,
  );
}

async function terminateCandidate(candidate: DevelopmentServerCandidate): Promise<void> {
  if (candidate.outcome !== undefined) {
    return;
  }

  candidate.process.kill("SIGTERM");
  await waitForCandidateExit(candidate, DEVELOPMENT_SERVER_SHUTDOWN_GRACE_MS);
  if (candidate.outcome !== undefined) {
    return;
  }

  candidate.process.kill("SIGKILL");
  await waitForCandidateExit(candidate, DEVELOPMENT_SERVER_SHUTDOWN_GRACE_MS);
  if (candidate.outcome === undefined) {
    throw new Error(
      `Development-server child ${String(candidate.process.pid)} did not exit after SIGTERM and SIGKILL.`,
    );
  }
}

async function waitForCandidateExit(
  candidate: DevelopmentServerCandidate,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([candidate.settled, delay(timeoutMs)]);
}

function createOwnedDevelopmentServerHandle(
  origin: string,
  candidate: DevelopmentServerCandidate,
): SharedDevelopmentServerHandle {
  const child = candidate.process;
  const close = () => {
    if (!child.killed) {
      child.kill();
    }
  };
  const removeHooks = () => {
    process.off("exit", close);
  };

  process.once("exit", close);
  child.once("error", removeHooks);
  child.once("exit", removeHooks);
  return {
    close: () => terminateCandidate(candidate),
    origin,
    process: child,
  };
}
