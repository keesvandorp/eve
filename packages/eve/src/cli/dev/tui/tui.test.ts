import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EveTUIRunnerOptions } from "./runner.js";

const mocks = vi.hoisted<{ runnerOptions: EveTUIRunnerOptions[] }>(() => ({
  runnerOptions: [],
}));

vi.mock("./runner.js", () => ({
  EveTUIRunner: class {
    constructor(options: EveTUIRunnerOptions) {
      mocks.runnerOptions.push(options);
    }

    async run(): Promise<void> {}
  },
}));

import { runDevelopmentTui } from "./tui.js";

describe("runDevelopmentTui", () => {
  beforeEach(() => {
    mocks.runnerOptions.length = 0;
  });

  it("creates a fresh client session for every TUI attached to the same server", async () => {
    await runDevelopmentTui({ serverUrl: "http://127.0.0.1:4321/" });
    await runDevelopmentTui({ serverUrl: "http://127.0.0.1:4321/" });

    expect(mocks.runnerOptions).toHaveLength(2);
    const [first, second] = mocks.runnerOptions;
    if (first === undefined || second === undefined) {
      throw new Error("Expected two TUI runner invocations.");
    }
    expect(first.client).not.toBe(second.client);
    expect(first.session).not.toBe(second.session);
  });
});
