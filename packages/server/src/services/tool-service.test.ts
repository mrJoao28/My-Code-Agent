import { describe, expect, test } from "bun:test";
import {
  MAX_IDENTICAL_REPEATS,
  MAX_TOOL_CALLS,
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
