import { test, expect, mock } from "bun:test";
import { streamAIResponse, type StreamDependencies, type StreamParams } from "./stream-service";

function setup(parts: unknown[], controller = new AbortController()) {
    const created: Record<string, unknown>[] = [], events: { event: string; data: string }[] = [];
    const create = mock(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: "saved-message" }; });
    const stream = { aborted: false, writeSSE: async (event: { event: string; data: string }) => { events.push(event); } } as unknown as Parameters<typeof streamAIResponse>[0];
    const dependencies: StreamDependencies = {
        db: { message: { create } } as unknown as StreamDependencies["db"],
        touchSession: mock(async () => {}),
        resolveModel: (() => ({ model: {}, provider: "ollama", modelId: "fixture" })) as unknown as StreamDependencies["resolveModel"],
        generate: (() => ({ fullStream: (async function* () {
            for (const part of parts) {
                if (part === "abort") { controller.abort(); return; }
                yield part;
            }
        })() })) as unknown as StreamDependencies["generate"],
    };
    const params: StreamParams = { sessionId: "s", model: "fixture", mode: "PLAN", history: [], cwd: null, abortController: controller };
    return { created, events, dependencies, params, stream, create };
}
test("generation streams parts, persists assistant once and signals its saved id", async () => {
    const fixture = setup([
        { type: "reasoning-delta", text: "summary" }, { type: "text-delta", text: "hello" }, { type: "text-delta", text: " world" },
        { type: "tool-call", toolName: "read_file", toolCallId: "t", input: { path: "a" } },
        { type: "tool-result", toolCallId: "t", output: "file content" },
    ]);
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.created[0]).toMatchObject({ role: "ASSISTANT", status: "COMPLETE", content: "hello world" });
    expect(fixture.created[0]!.parts).toEqual([
        { type: "reasoning", text: "summary" }, { type: "text", text: "hello world" },
        { type: "tool-call", id: "t", name: "read_file", args: { path: "a" } },
        { type: "tool-result", id: "t", name: "read_file", result: "file content" },
    ]);
    expect(JSON.parse(fixture.events.at(-1)!.data)).toMatchObject({ type: "done", messageId: "saved-message" });
});
test("cancellation persists partial assistant without declaring completion", async () => {
    const fixture = setup([{ type: "text-delta", text: "partial" }, "abort"]);
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created[0]).toMatchObject({ role: "ASSISTANT", status: "INTERRUPTED", content: "partial" });
    expect(fixture.events.some(event => event.event === "done")).toBe(false);
});
test("provider failure is persisted and streamed as an error", async () => {
    const fixture = setup([{ type: "error", error: new Error("fixture-provider-failure") }]);
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created[0]).toMatchObject({ role: "ERROR", content: "fixture-provider-failure" });
    expect(JSON.parse(fixture.events.at(-1)!.data)).toEqual({ type: "error", message: "fixture-provider-failure" });
});
test("tool denial/failure is associated with its original call", async () => {
    const fixture = setup([
        { type: "tool-call", toolName: "write_file", toolCallId: "t", input: { path: "a", content: "x" } },
        { type: "tool-error", toolCallId: "t", error: new Error("action denied") },
    ]);
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    const result = fixture.events.find(event => event.event === "tool-result")!;
    expect(JSON.parse(result.data)).toMatchObject({ toolCallId: "t", toolName: "write_file", result: "Tool failed: action denied" });
});
test("model-resolution failure is handled inside the generation lifecycle", async () => {
    const fixture = setup([]);
    fixture.dependencies.resolveModel = () => { throw new Error("unsupported fixture model"); };
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created[0]).toMatchObject({ role: "ERROR", content: "unsupported fixture model" });
});

test("provider account cancellation reaches the generation and preserves partial output as interrupted", async () => {
    const fixture = setup([]);
    const connection = new AbortController();
    fixture.dependencies.resolveModel = (() => ({ model: {}, provider: "ollama", modelId: "fixture", abortSignal: connection.signal })) as unknown as StreamDependencies["resolveModel"];
    fixture.dependencies.generate = (() => ({ fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        connection.abort();
    })() })) as unknown as StreamDependencies["generate"];
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.params.abortController.signal.aborted).toBe(true);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]).toMatchObject({ role: "ASSISTANT", status: "INTERRUPTED", content: "partial" });
    expect(fixture.events.some(event => event.event === "done")).toBe(false);
});
