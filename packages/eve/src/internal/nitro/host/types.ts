import type { CompileAgentResult } from "#compiler/compile-agent.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import type { ResolvedSchedule } from "#runtime/types.js";
import type { GeneratedCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";

/**
 * Route surface included in one programmatic Nitro host build.
 */
export type NitroBuildSurface = "all" | "app" | "flow";

/** A Nitro development server started and owned by the current process. */
export interface StartedDevelopmentServer {
  readonly kind: "started";
  readonly appRoot: string;
  close(): Promise<void>;
  readonly url: string;
}

/** A live development server owned by another process. */
export interface ExistingDevelopmentServer {
  readonly kind: "existing";
  readonly appRoot: string;
  readonly url: string;
}

/** Result of resolving a development server for an app root. */
export type DevelopmentServerHandle = StartedDevelopmentServer | ExistingDevelopmentServer;

export interface DevelopmentServerOptions {
  readonly existing?: "attach-if-unconfigured" | "reject";
  readonly host?: string;
  readonly onBootProgress?: DevBootProgressReporter;
  readonly port?: number;
}

/**
 * Handle returned after starting one built Nitro server.
 */
export interface ProductionServerHandle {
  close(): Promise<void>;
  url: string;
  wait(): Promise<void>;
}

export interface PreparedApplicationHost {
  appRoot: string;
  compileResult: CompileAgentResult;
  compiledArtifacts: GeneratedCompiledArtifactsFiles;
  scheduleRegistrations: readonly ScheduleRegistration[];
  schedules: readonly ResolvedSchedule[];
  workflowBuildDir: string;
}
