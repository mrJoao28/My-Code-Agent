import { test, expect } from "bun:test";
import { ToolCallGuard, MAX_IDENTICAL_REPEATS } from "./tool-service";
test("loop guard recognizes equivalent nested arguments regardless of key order", () => {
    const guard = new ToolCallGuard();
    for (let i = 0; i < MAX_IDENTICAL_REPEATS; i++) guard.register("read", { path: "a", options: { limit: 1, offset: 0 } });
    expect(() => guard.register("read", { options: { offset: 0, limit: 1 }, path: "a" })).toThrow();
});
test("loop guard distinguishes tool names and ordered array arguments", () => {
    const guard = new ToolCallGuard();
    for (let i = 0; i < MAX_IDENTICAL_REPEATS; i++) {
        guard.register("first", { values: [1, 2] });
        guard.register("first", { values: [2, 1] });
        guard.register("second", { values: [1, 2] });
    }
    expect(() => guard.register("second", { values: [1, 2] })).toThrow();
});
