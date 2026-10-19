import { expect, test } from "bun:test";
import { Hono } from "hono";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executePrompt, readExecEvents } from "./exec";
import { parseOptions, type ExecOptions } from "./options";
import { localAuthentication } from "../../server/src/security/auth";
import { approvals } from "../../server/src/security/permissions";
import { setDockerAvailable } from "../../server/src/security/sandbox";
import { handleSubmit, type ChatDependencies } from "../../server/src/services/chat-service";
import { streamAIResponse } from "../../server/src/services/stream-service";
import { withFixture } from "../../server/src/test-support";
import { streamText, MockLanguageModelV3, convertArrayToReadableStream } from "../../server/src/provider-test-support";

test("exec validates explicit permissions, mode, model and JSONL without changing interactive defaults", () => {
    expect(parseOptions(["exec", "leia"])).toEqual({ command: "exec", prompt: "leia", mode: "plan", json: false, approve: "none" });
    expect(parseOptions(["exec", "edite", "--mode", "build", "--model", "custom", "--json", "--approve", "all"])).toMatchObject({ mode: "build", model: "custom", json: true, approve: "all" });
    for (const args of [["exec"], ["exec", " "], ["exec", "a", "b"], ["exec", "a", "--approve", "yes"], ["exec", "a", "--mode", "BUILD"], ["exec", "a", "--model"], ["exec", "a", "--json", "--json"], ["exec", "a", "--unknown", "x"]]) expect(() => parseOptions(args)).toThrow();
});

test("JSON SSE preserves UTF-8 and CRLF across single-byte chunks", async () => {
    const source = new TextEncoder().encode('event: text-delta\r\ndata: {"type":"text-delta","text":"ação"}\r\n\r\ndata: {"type":"done","messageId":"m","durationMs":1}\r\n\r\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of source) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const events = [];
    for await (const event of readExecEvents(body)) events.push(event);
    expect(events).toEqual([{ type: "text-delta", text: "ação" }, { type: "done", messageId: "m", durationMs: 1 }]);
});

test("exec distinguishes incomplete streams, HTTP failures, cancellation and approval denial", async () => {
    const options: ExecOptions = { prompt: "leia", mode: "plan", json: false, approve: "none" };
    const signal = new AbortController();
    const connection = { url: "http://127.0.0.1", token: "private", workspace: "/workspace", sessionId: "s", signal: signal.signal };
    const response = (data: unknown) => new Response(`data: ${JSON.stringify(data)}\n\n`);
    const incomplete = await executePrompt(options, connection, { fetch: async () => response({ type: "text-delta", text: "parcial" }) });
    expect(incomplete).toMatchObject({ status: "failure", exitCode: 1 });
    expect(incomplete.error).toContain("sem confirmação");
    const failure = await executePrompt(options, connection, { fetch: async () => new Response('{"error":"MODEL_API_KEY_REQUIRED"}', { status: 428 }) });
    expect(failure.exitCode).toBe(1);
    signal.abort();
    const cancelled = await executePrompt(options, connection, { fetch: async () => { throw new Error("abort"); } });
    expect(cancelled).toMatchObject({ status: "cancelled", exitCode: 130 });
});

for (const scenario of ["read", "deny-write", "allow-write", "deny-command"] as const) {
    test(`headless HTTP → chat-service → stream-service → SDK → tools: ${scenario}`, withFixture(async ({ cwd }) => {
        await writeFile(join(cwd, "input.txt"), "LEITURA-REAL\r\n");
        const sessionId = `exec-${scenario}`;
        const previousRoots = process.env.MYAGENT_WORKSPACE_ROOTS;
        process.env.MYAGENT_WORKSPACE_ROOTS = JSON.stringify([cwd]);
        const policy = scenario === "allow-write" ? "all" : scenario === "deny-command" ? "reads" : "none";
        approvals.setAutomation(sessionId, policy);
        setDockerAvailable(true);
        const rows: Record<string, unknown>[] = [];
        const database = {
            session: { findUnique: async () => ({ id: sessionId, cwd }), updateMany: async () => ({ count: 1 }) },
            message: {
                create: async ({ data }: { data: Record<string, unknown> }) => { const row = { ...data, id: `message-${rows.length}`, createdAt: new Date() }; rows.push(row); return row; },
                update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find(row => row.id === where.id)!, data),
                updateMany: async () => ({ count: 0 }),
                findMany: async () => [...rows].reverse(),
            },
            sessionContext: { findUnique: async () => ({ tokenLimit: 100_000, messages: [] }), upsert: async ({ create }: { create: unknown }) => create },
        } as unknown as ChatDependencies["db"];
        let step = 0;
        const toolName = scenario === "read" ? "read_file" : scenario === "deny-command" ? "type_check" : "write_file";
        const input = toolName === "read_file" ? { path: "input.txt" } : toolName === "write_file" ? { path: "output.txt", content: "aprovado" } : {};
        const provider = new MockLanguageModelV3({ doStream: async options => {
            const final = step++ > 0;
            if (final && scenario === "read") expect(JSON.stringify(options.prompt)).toContain("LEITURA-REAL");
            if (final && scenario.startsWith("deny")) expect(JSON.stringify(options.prompt)).toContain("negada");
            return { stream: convertArrayToReadableStream([
                { type: "stream-start" as const, warnings: [] },
                ...(final ? [
                    { type: "text-start" as const, id: "answer" },
                    { type: "text-delta" as const, id: "answer", delta: "Resposta final" },
                    { type: "text-end" as const, id: "answer" },
                ] : [{ type: "tool-call" as const, toolCallId: "call-1", toolName, input: JSON.stringify(input) }]),
                { type: "finish" as const, finishReason: { unified: final ? "stop" as const : "tool-calls" as const, raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
            ]) };
        } });
        const dependencies: ChatDependencies = {
            db: database, validateSessionWorkspace: async () => cwd, isSupportedChatModel: (id: string): id is string => true, isModelConfigured: () => true, touchSession: async () => {},
            streamAIResponse: (stream, params) => streamAIResponse(stream, params, { db: database, touchSession: async () => {}, generate: streamText, resolveModel: () => ({ model: provider, provider: "ollama", modelId: "fixture", contextWindow: 200_000 }) }),
        };
        const token = "x".repeat(40);
        const app = new Hono().use("*", localAuthentication(token))
            .post("/chat/:sessionId", async c => handleSubmit(c, await c.req.json(), dependencies))
            .post("/permissions/:sessionId/:approvalId", async c => { const body = await c.req.json(); return c.json({ accepted: approvals.decide(c.req.param("sessionId"), c.req.param("approvalId"), body.approved) }); });
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
        try {
            expect((await fetch(`http://127.0.0.1:${server.port}/chat/${sessionId}`, { method: "POST" })).status).toBe(401);
            const events: string[] = [];
            const result = await executePrompt({ prompt: "execute a tarefa", mode: "build", model: "fixture", approve: policy, json: true }, { url: `http://127.0.0.1:${server.port}`, token, workspace: cwd, sessionId, signal: new AbortController().signal }, { event: event => { events.push(event.type); } });
            expect(result).toMatchObject({ status: scenario.startsWith("deny") ? "denied" : "success", exitCode: scenario.startsWith("deny") ? 3 : 0, text: "Resposta final", toolCalls: 1, totalTokens: 30 });
            expect(events).toContain("done");
            expect(provider.doStreamCalls).toHaveLength(2);
            expect(rows.at(-1)?.status).toBe("COMPLETE");
            if (scenario === "allow-write") expect(await readFile(join(cwd, "output.txt"), "utf8")).toBe("aprovado");
            if (scenario === "deny-write") expect(await stat(join(cwd, "output.txt")).catch(() => undefined)).toBeUndefined();
        } finally {
            await server.stop(true); approvals.forget(sessionId); setDockerAvailable(false);
            if (previousRoots === undefined) delete process.env.MYAGENT_WORKSPACE_ROOTS; else process.env.MYAGENT_WORKSPACE_ROOTS = previousRoots;
        }
    }), 30_000);
}
