import { test, expect, mock } from "bun:test";
import { streamAIResponse, cancelAllGenerations, type StreamDependencies, type StreamParams } from "./stream-service";
import { streamText } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { getSessionTodos, clearSessionTodos } from "../tools/todo-write";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFixture } from "../test-support";
import { contextBudget, fitContextWindow, persistSessionContext } from "./session-context";

test("every generation reloads root instructions and delivers local instructions through real SDK tool results", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "AGENTS.md"), "regra local exclusiva: fixtures tipadas");
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;");
    const previousRoots = process.env.MYAGENT_WORKSPACE_ROOTS;
    process.env.MYAGENT_WORKSPACE_ROOTS = JSON.stringify([cwd]);
    try {
        for (const generation of [0, 1]) {
            await writeFile(join(cwd, "AGENTS.md"), `regra raiz da geração ${generation}`);
            const fixture = setup([]);
            fixture.params.cwd = cwd;
            fixture.params.history = [{ role: "user", content: "Leia src/a.ts sem criar documentação" }];
            let step = 0;
            const provider = new MockLanguageModelV3({ doStream: async options => {
                const prompt = JSON.stringify(options.prompt);
                expect(prompt).toContain(`regra raiz da geração ${generation}`);
                expect(prompt).not.toContain(`regra raiz da geração ${1 - generation}`);
                const final = step++ > 0;
                if (final) {
                    expect(prompt).toContain("regra local exclusiva: fixtures tipadas");
                    expect(prompt).toContain("projectInstructions");
                } else expect(prompt).not.toContain("regra local exclusiva: fixtures tipadas");
                return { stream: convertArrayToReadableStream([
                    { type: "stream-start" as const, warnings: [] },
                    ...(final ? [
                        { type: "text-start" as const, id: "answer" },
                        { type: "text-delta" as const, id: "answer", delta: "Arquivo analisado" },
                        { type: "text-end" as const, id: "answer" },
                    ] : [{ type: "tool-call" as const, toolCallId: "read", toolName: "read_file", input: '{"path":"src/a.ts"}' }]),
                    { type: "finish" as const, finishReason: { unified: final ? "stop" as const : "tool-calls" as const, raw: undefined },
                        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
                ]) };
            } });
            fixture.dependencies.resolveModel = () => ({ model: provider, provider: "ollama", modelId: "fixture", contextWindow: 200_000 });
            fixture.dependencies.generate = streamText;
            await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
            expect(provider.doStreamCalls).toHaveLength(2);
            expect(fixture.created[0]?.status).toBe("COMPLETE");
            expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe(`regra raiz da geração ${generation}`);
            expect((await readdir(cwd)).sort()).toEqual(["AGENTS.md", "src"]);
            expect((await readdir(join(cwd, "src"))).sort()).toEqual(["AGENTS.md", "a.ts"]);
        }
    } finally {
        if (previousRoots === undefined) delete process.env.MYAGENT_WORKSPACE_ROOTS;
        else process.env.MYAGENT_WORKSPACE_ROOTS = previousRoots;
    }
}));

test("real SDK completes 30 successive reads with every middle line visible and full results persisted", withFixture(async ({ cwd }) => {
    const fixture = setup([]);
    fixture.params.cwd = cwd;
    fixture.params.history = [{ role: "user", content: "Leia os 30 arquivos" }];
    const content = Array.from({ length: 300 }, (_, i) => `linha-${i} ${"x".repeat(16)}`).join("\r\n");
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeFile(join(cwd, `${i}.ts`), content)));
    const previousRoots = process.env.MYAGENT_WORKSPACE_ROOTS;
    process.env.MYAGENT_WORKSPACE_ROOTS = JSON.stringify([cwd]);
    let step = 0;
    const snapshots: unknown[] = [];
    const db = { sessionContext: {
        findUnique: async () => ({ tokenLimit: 16_384 }),
        upsert: async ({ create }: { create: Record<string, unknown> }) => { snapshots.push(create); return create; },
    } } as unknown as Parameters<typeof persistSessionContext>[0];
    const dependencies: Partial<StreamDependencies> = { ...fixture.dependencies, db: { ...fixture.dependencies.db, ...db } };
    delete dependencies.saveContext;
    const provider = new MockLanguageModelV3({ doStream: async options => {
        const prompt = JSON.stringify(options.prompt);
        if (step > 0) {
            expect(prompt.match(/151: linha-150/g)).toHaveLength(step);
            expect(prompt.match(/300: linha-299/g)).toHaveLength(step);
        }
        const final = step === 30;
        return { stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            ...(final ? [
                { type: "text-start" as const, id: "answer" },
                { type: "text-delta" as const, id: "answer", delta: "30 arquivos lidos" },
                { type: "text-end" as const, id: "answer" },
            ] : [{ type: "tool-call" as const, toolCallId: `read-${step}`, toolName: "read_file", input: JSON.stringify({ path: `${step++}.ts` }) }]),
            { type: "finish" as const, finishReason: { unified: final ? "stop" as const : "tool-calls" as const, raw: undefined },
                usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
        ]) };
    } });
    fixture.dependencies.generate = streamText;
    fixture.dependencies.resolveModel = () => ({ model: provider, provider: "ollama", modelId: "fixture", contextWindow: 200_000 });
    try {
        await streamAIResponse(fixture.stream, fixture.params, { ...dependencies, generate: streamText, resolveModel: fixture.dependencies.resolveModel });
        expect(provider.doStreamCalls).toHaveLength(31);
        expect(snapshots).toHaveLength(31);
        for (const snapshot of snapshots as { tokenLimit: number }[]) {
            expect(snapshot.tokenLimit).toBeGreaterThan(16_384);
            expect(snapshot.tokenLimit).toBeLessThan(contextBudget(200_000).tokenLimit);
        }
        expect(fixture.params.abortController.signal.aborted).toBe(false);
        expect(fixture.events.at(-1)?.event).toBe("done");
        expect(fixture.created[0]?.status).toBe("COMPLETE");
        const results = (fixture.created[0]?.parts as { type: string; result?: string }[]).filter(p => p.type === "tool-result");
        expect(results).toHaveLength(30);
        for (const result of results) {
            const page = JSON.parse(result.result!);
            expect(page.content).toContain("151: linha-150");
            expect(page.content).toContain("300: linha-299");
        }
    } finally {
        if (previousRoots === undefined) delete process.env.MYAGENT_WORKSPACE_ROOTS;
        else process.env.MYAGENT_WORKSPACE_ROOTS = previousRoots;
    }
}), 30_000);

test("real SDK receives the first duplicate as a tool error and can recover without aborting", async () => {
    const fixture = setup([]);
    fixture.params.cwd = process.cwd();
    fixture.params.history = [{ role: "user", content: "leia" }];
    fixture.dependencies.saveContext = async messages => fitContextWindow(messages, 100_000).messages;
    let step = 0;
    const provider = new MockLanguageModelV3({ doStream: async options => {
        const final = step++ === 2;
        if (final) expect(JSON.stringify(options.prompt)).toContain("já foi obtido");
        return { stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            ...(final ? [
                { type: "text-start" as const, id: "answer" },
                { type: "text-delta" as const, id: "answer", delta: "Usei a primeira leitura" },
                { type: "text-end" as const, id: "answer" },
            ] : [{ type: "tool-call" as const, toolCallId: `duplicate-${step}`, toolName: "read_file", input: '{"path":"AGENTS.md"}' }]),
            { type: "finish" as const, finishReason: { unified: final ? "stop" as const : "tool-calls" as const, raw: undefined },
                usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
        ]) };
    } });
    fixture.dependencies.generate = streamText;
    fixture.dependencies.resolveModel = () => ({ model: provider, provider: "ollama", modelId: "fixture", contextWindow: 200_000 });
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(provider.doStreamCalls).toHaveLength(3);
    expect(fixture.params.abortController.signal.aborted).toBe(false);
    expect(fixture.created[0]?.status).toBe("COMPLETE");
    expect(fixture.events.at(-1)?.event).toBe("done");
});

function setup(parts: unknown[], controller = new AbortController()) {
    const created: Record<string, unknown>[] = [], events: { event: string; data: string }[] = [];
    const create = mock(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: "saved-message" }; });
    const stream = { aborted: false, writeSSE: async (event: { event: string; data: string }) => { events.push(event); } } as unknown as Parameters<typeof streamAIResponse>[0];
    const dependencies: StreamDependencies = {
        db: { message: { create } } as unknown as StreamDependencies["db"],
        touchSession: mock(async () => {}),
        saveContext: async messages => messages,
        refreshContext: mock(async () => {}),
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

test.each([[1, 3], [3, 5], [5, 7], [40, 38]])("real SDK with budget %s and batch %s persists a normal partial answer", async (limit, batch) => {
    const previous = process.env.MYAGENT_MAX_TOOL_CALLS;
    process.env.MYAGENT_MAX_TOOL_CALLS = String(limit);
    const fixture = setup([]);
    fixture.params.cwd = process.cwd();
    fixture.params.sessionId = `budget-${limit}`;
    fixture.params.history = [{ role: "user", content: "Analise o projeto" }];
    const summary = "Achado confirmado. Falta verificar os testes.";
    const provider = new MockLanguageModelV3({ doStream: async options => {
        const final = options.toolChoice?.type === "none";
        if (final) {
            expect(options.tools ?? []).toHaveLength(0);
            expect(JSON.stringify(options.prompt)).toContain("o que ficou por verificar");
            expect(JSON.stringify(options.prompt)).toContain("todo_write");
        }
        return { stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            ...(final ? [
                { type: "text-start" as const, id: "answer" },
                { type: "text-delta" as const, id: "answer", delta: summary },
                { type: "text-end" as const, id: "answer" },
            ] : Array.from({ length: batch }, (_, i) => ({
                type: "tool-call" as const, toolCallId: `t-${i}`, toolName: "todo_write",
                input: JSON.stringify({ todos: [{ content: `item-${i}`, status: "pending" }] }),
            }))),
            { type: "finish" as const, finishReason: { unified: final ? "stop" as const : "tool-calls" as const, raw: undefined },
                usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
        ]) };
    } });
    fixture.dependencies.generate = streamText;
    fixture.dependencies.resolveModel = () => ({ model: provider, provider: "ollama", modelId: "fixture" });
    try {
        await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
        expect(provider.doStreamCalls).toHaveLength(2);
        expect(fixture.created).toHaveLength(1);
        expect(fixture.created[0]).toMatchObject({ role: "ASSISTANT", status: "COMPLETE", content: summary });
        expect(fixture.created[0]!.parts).toContainEqual({ type: "tool-limit-warning", limit });
        const results = fixture.events.filter(event => event.event === "tool-result").map(event => JSON.parse(event.data).result as string);
        expect(results.filter(result => !result.startsWith("Tool failed:"))).toHaveLength(Math.min(limit, batch));
        expect(results.filter(result => result.includes("Limite máximo"))).toHaveLength(Math.max(0, batch - limit));
        expect(getSessionTodos(fixture.params.sessionId)).toHaveLength(1);
        expect(fixture.params.abortController.signal.aborted).toBe(false);
        expect(fixture.events.some(event => event.event === "error")).toBe(false);
        expect(fixture.events.at(-1)!.event).toBe("done");
    } finally {
        clearSessionTodos(fixture.params.sessionId);
        if (previous === undefined) delete process.env.MYAGENT_MAX_TOOL_CALLS;
        else process.env.MYAGENT_MAX_TOOL_CALLS = previous;
    }
});

test("application shutdown cancels active generations and waits for cleanup", async () => {
    const fixture = setup([]);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    fixture.dependencies.generate = ((options: Parameters<StreamDependencies["generate"]>[0]) => {
        started();
        return { fullStream: (async function* () {
            await new Promise<void>(resolve => {
                if (options.abortSignal?.aborted) resolve();
                else options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
        })() };
    }) as unknown as StreamDependencies["generate"];
    const running = streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    await ready;
    await cancelAllGenerations();
    await running;
    expect(fixture.params.abortController.signal.aborted).toBe(true);
    expect(fixture.events.some(event => event.event === "done")).toBe(false);
});

test("usage accumulates every model step once and survives persistence", async () => {
    const fixture = setup([
        { type: "finish-step", usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 } },
        { type: "finish-step", usage: { inputTokens: 2_000, outputTokens: 300, totalTokens: 2_300 } },
        { type: "finish", totalUsage: { totalTokens: 3_500 } },
    ]);
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created[0]!.totalTokens).toBe(3_500);
    expect(fixture.events.filter(event => event.event === "usage").map(event => JSON.parse(event.data).totalTokens)).toEqual([1_200, 3_500]);
});

test("every model step uses the snapshot returned by context persistence", async () => {
    const fixture = setup([]);
    const saved = [{ role: "user" as const, content: "persisted bounded context" }];
    fixture.dependencies.saveContext = mock(async () => saved);
    fixture.dependencies.generate = ((options: Parameters<StreamDependencies["generate"]>[0]) => ({ fullStream: (async function* () {
        const step = await options.prepareStep!({ messages: fixture.params.history } as Parameters<NonNullable<typeof options.prepareStep>>[0]);
        expect(step?.messages).toEqual(saved);
        yield { type: "text-delta", text: "answer" };
    })() })) as unknown as StreamDependencies["generate"];
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.dependencies.saveContext).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.refreshContext).toHaveBeenCalledTimes(1);
});

test.each(["abort", "failure"])("reported usage is retained after %s even without text", async ending => {
    const fixture = setup([
        { type: "finish-step", usage: { inputTokens: 100, outputTokens: 50 } },
        ending === "abort" ? "abort" : { type: "error", error: new Error("fixture failure") },
    ]);
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]!.totalTokens).toBe(150);
    expect(fixture.created[0]!.role).toBe(ending === "abort" ? "ASSISTANT" : "ERROR");
    expect(fixture.events.some(event => event.event === "done")).toBe(false);
});

test("missing or invalid provider usage is never estimated from text", async () => {
    const fixture = setup([
        { type: "text-delta", text: "some text" },
        ...[undefined, -1, 1.5, NaN].map(totalTokens => ({ type: "finish-step", usage: { totalTokens } })),
    ]);
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created[0]!.totalTokens).toBeNull();
    expect(fixture.events.some(event => event.event === "usage")).toBe(false);
});

test("failed terminal SSE does not persist or count the same generation twice", async () => {
    const fixture = setup([{ type: "finish-step", usage: { totalTokens: 200 } }]);
    fixture.stream.writeSSE = async event => {
        if (event.event === "done") throw new Error("transport closed");
    };
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]!.totalTokens).toBe(200);
});
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

test("request cancellation before generation prevents the model call", async () => {
    const fixture = setup([]);
    const request = new AbortController(); request.abort(new Error("fixture cancelled"));
    fixture.params.requestSignal = request.signal;
    const generate = mock(() => { throw new Error("unexpected model call"); }); fixture.dependencies.generate = generate as unknown as StreamDependencies["generate"];
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(generate).not.toHaveBeenCalled();
    expect(fixture.created).toHaveLength(0);
});

test("generation limit preserves partial output and signals its cause", async () => {
    const fixture = setup([]);
    fixture.dependencies.generate = (() => ({ fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        fixture.params.abortController.abort(new Error("GENERATION_TIMEOUT: fixture limit"));
    })() })) as unknown as StreamDependencies["generate"];
    await streamAIResponse(fixture.stream, fixture.params, fixture.dependencies);
    expect(fixture.created[0]).toMatchObject({ status: "INTERRUPTED", content: "partial" });
    expect(JSON.parse(fixture.events.at(-1)!.data)).toEqual({ type: "error", message: "GENERATION_TIMEOUT: fixture limit" });
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
