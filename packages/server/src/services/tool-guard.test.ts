import { test, expect } from "bun:test";
import { ToolCallGuard, MAX_IDENTICAL_REPEATS } from "./tool-service";
test("loop guard recognizes equivalent nested arguments regardless of key order", () => {
    const guard = new ToolCallGuard();
    guard.register("read", { path: "a", options: { limit: 1, offset: 0 } });
    for (let i = 1; i < MAX_IDENTICAL_REPEATS; i++) expect(() => guard.register("read", { path: "a", options: { limit: 1, offset: 0 } })).toThrow("já foi obtido");
    expect(() => guard.register("read", { options: { offset: 0, limit: 1 }, path: "a" })).toThrow();
});
test("loop guard distinguishes tool names and ordered array arguments", () => {
    const guard = new ToolCallGuard();
    for (let i = 0; i < MAX_IDENTICAL_REPEATS; i++) {
        for (const [name, values] of [["first", [1, 2]], ["first", [2, 1]], ["second", [1, 2]]] as const) {
            if (i === 0) guard.register(name, { values });
            else expect(() => guard.register(name, { values })).toThrow("já foi obtido");
        }
    }
    expect(() => guard.register("second", { values: [1, 2] })).toThrow();
});


test("first repetition is a recoverable tool error, persistent repetitions abort", () => {
    const guard = new ToolCallGuard();
    guard.register("read_file", { path: "a" });
    expect(() => guard.register("read_file", { path: "a" })).toThrow("já foi obtido");
    expect(() => guard.register("read_file", { path: "a" })).toThrow("já foi obtido");
    expect(() => guard.register("read_file", { path: "a" })).toThrow("possível loop");
});

test("30 rereads after eviction are permitted and summaries do not count as visible results", () => {
    const guard = new ToolCallGuard();
    for (let i = 0; i < 30; i++) {
        guard.updateContext([{ role: "user", content: "continue" }, { role: "assistant", content: "Resumo: a foi lido" }]);
        expect(() => guard.register("read_file", { path: "a" })).not.toThrow();
    }
});

test("visible successful results prevent repetition; errors and cropped pages permit another read", () => {
    const guard = new ToolCallGuard();
    const call = { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "a", toolName: "read_file", input: { path: "a" } }] };
    const result = { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "a", toolName: "read_file", output: { type: "text" as const, value: "contents" } }] };
    guard.updateContext([call, result]);
    expect(() => guard.register("read_file", { path: "a" })).toThrow("já foi obtido");
    result.content[0]!.output.value = "Tool failed: denied";
    guard.updateContext([call, result]);
    expect(() => guard.register("read_file", { path: "a" })).not.toThrow();
    result.content[0]!.output.value = JSON.stringify({ content: "a", contextTruncated: true });
    guard.updateContext([call, result]);
    expect(() => guard.register("read_file", { path: "a" })).not.toThrow();
});

test("a successful edit invalidates a previous read even while its old result is visible", () => {
    const guard = new ToolCallGuard();
    const history = ["read_file", "edit_file"].flatMap((toolName, i) => [
        { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: String(i), toolName, input: { path: "a" } }] },
        { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: String(i), toolName, output: { type: "text" as const, value: "ok" } }] },
    ]);
    guard.register("read_file", { path: "a" });
    guard.updateContext(history);
    expect(() => guard.register("read_file", { path: "a" })).not.toThrow();
});
