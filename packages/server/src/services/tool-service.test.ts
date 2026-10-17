import { describe, expect, test } from "bun:test";
import {
  MAX_IDENTICAL_REPEATS,
  MAX_TOOL_CALLS,
  MAX_TOOL_CALLS_CEILING,
  getMaxToolCalls,
  ToolCallGuard,
  ToolLoopDetectedError,
} from "./tool-service";

describe("ToolCallGuard", () => {
  test("allows different tool calls within the limit", () => {
    const guard = new ToolCallGuard();

    guard.register("read_file", { path: "a.ts" });
    guard.register("read_file", { path: "b.ts" });

    expect(true).toBe(true);
  });

  test("blocks repeated identical calls after the configured threshold", () => {
    const guard = new ToolCallGuard();
    const args = { path: "package.json" };

    for (let i = 0; i < MAX_IDENTICAL_REPEATS; i++) {
      guard.register("read_file", args);
    }

    expect(() => guard.register("read_file", args)).toThrow(ToolLoopDetectedError);
  });

  test("blocks a generation after the global tool-call limit", () => {
    const guard = new ToolCallGuard();

    for (let i = 0; i < MAX_TOOL_CALLS; i++) {
      guard.register("read_file", { path: `file-${i}.ts` });
    }

    expect(() => guard.register("read_file", { path: "one-too-many.ts" })).toThrow(
      /máximo de tool calls/
    );
  });
});

test.each([
  [undefined, 40], ["", 40], ["12", 12], ["0", 40], ["-1", 40],
  ["abc", 40], ["1.5", 40], ["Infinity", 40], ["201", MAX_TOOL_CALLS_CEILING],
])("tool budget configuration %s resolves to %s", (value, expected) => {
  const previous = process.env.MYAGENT_MAX_TOOL_CALLS;
  try {
    if (value === undefined) delete process.env.MYAGENT_MAX_TOOL_CALLS;
    else process.env.MYAGENT_MAX_TOOL_CALLS = value;
    expect(getMaxToolCalls()).toBe(expected);
    expect(new ToolCallGuard().limit).toBe(expected);
  } finally {
    if (previous === undefined) delete process.env.MYAGENT_MAX_TOOL_CALLS;
    else process.env.MYAGENT_MAX_TOOL_CALLS = previous;
  }
});
