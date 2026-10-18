import { expect, test } from "bun:test";
import { join } from "node:path";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { ChatGPTStore } from "../chatgpt-store";
import { ChatGPTService } from "../chatgpt";
import { resolveChatGPTModel } from "./chatgpt";
import { requireCompletedChatGPTStream } from "./chatgpt-stream";
import { withFixture } from "../../test-support";

function connected(root: string) {
    const store = new ChatGPTStore(join(root, "chatgpt-credentials.json"));
    store.write({ hostId: "urn:uuid:fixture", activeId: "fixture-client", accounts: [{
        clientId: "fixture-client", subject: "fixture-subject", label: "fixture@example.test",
        tokens: { access: "fixture-access", refresh: "fixture-refresh", id: "fixture-id", expiresAt: Date.now() + 3_600_000, scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] },
        models: [{ slug: "fixture-model", name: "Fixture model" }],
    }] });
    return new ChatGPTService({ enabled: () => true, store });
}
function sse(events: unknown[]) {
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
const response = {
    id: "resp_fixture", created_at: 1, model: "fixture-model", status: "completed",
    usage: { input_tokens: 5, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
};
function textEvents() {
    return [
        { type: "response.created", response },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_fixture", role: "assistant", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "Resposta fixture" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "Resposta fixture", annotations: [] }] } },
        { type: "response.completed", response },
    ];
}
test("ChatGPT uses OAuth, developer instructions and namespaced tools through the real AI SDK", withFixture(async ({ root }) => {
    const service = connected(root);
    const requests: Record<string, any>[] = [];
    let executed = 0;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.openai.com/v1/responses");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-access");
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(init!.body as string); requests.push(body);
        if (requests.length === 1) {
            const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "echo", namespace: "myagent", status: "completed", arguments: '{"text":"fixture"}' };
            return sse([
                { type: "response.created", response },
                { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
                { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
                { type: "response.output_item.done", output_index: 0, item },
                { type: "response.completed", response },
            ]);
        }
        return sse(textEvents());
    }) as typeof fetch;
    const resolved = resolveChatGPTModel("chatgpt:fixture-model", service, fetcher);
    const result = streamText({
        model: resolved.model, system: "Instruções do agente", messages: [{ role: "user", content: "Execute echo" }],
        providerOptions: resolved.providerOptions, maxRetries: resolved.maxRetries, stopWhen: stepCountIs(3),
        tools: { echo: tool({ inputSchema: z.object({ text: z.string() }), providerOptions: resolved.toolOptions,
            execute: async ({ text }) => { executed++; return text; } }) },
    });
    const events = [];
    for await (const event of result.fullStream) { if (event.type === "error") throw event.error; events.push(event); }
    expect(executed).toBe(1);
    expect(requests).toHaveLength(2);
    expect(await result.text).toBe("Resposta fixture");
    for (const body of requests) {
        expect(body.store).toBe(false); expect(body.stream).toBe(true);
        expect(body.model).toBe("fixture-model");
        expect(body.input.some((item: { role?: string }) => item.role === "system")).toBe(false);
        expect(body.input.some((item: { role?: string }) => item.role === "developer")).toBe(true);
        expect(body.tools[0].type).toBe("namespace");
        expect(body.tools[0].tools[0].name).toBe("echo");
        expect(body).not.toHaveProperty("previous_response_id"); expect(body).not.toHaveProperty("max_output_tokens");
    }
    expect(requests[1]!.input.some((item: { type: string }) => item.type === "function_call_output")).toBe(true);
    expect(events.some(event => event.type === "tool-result")).toBe(true);
}));

test("ChatGPT stream rejects EOF, partial/incomplete responses and usage failures after text", async () => {
    for (const ending of [undefined, { type: "response.incomplete", response: { status: "incomplete" } },
        { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }]) {
        const events = [{ type: "response.output_text.delta", delta: "partial" }, ...(ending ? [ending] : [])];
        await expect(requireCompletedChatGPTStream(sse(events)).text()).rejects.toThrow();
    }
    await expect(requireCompletedChatGPTStream(sse([{ type: "response.completed", response: { status: "completed" } }])).text()).resolves.toContain("response.completed");
});

test("ChatGPT stream handles fragmented UTF-8 and refuses oversized event lines", async () => {
    const data = new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"ação"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    const fragments = new ReadableStream<Uint8Array>({ start(controller) {
        for (const byte of data) controller.enqueue(new Uint8Array([byte])); controller.close();
    } });
    expect(await requireCompletedChatGPTStream(new Response(fragments, { headers: { "Content-Type": "text/event-stream" } })).text()).toContain("ação");
    await expect(requireCompletedChatGPTStream(new Response("data: " + "x".repeat(1_000_001), { headers: { "Content-Type": "text/event-stream" } })).text()).rejects.toThrow();
});

test("switching ChatGPT accounts aborts an in-flight generation and never falls back to an API key", withFixture(async ({ root }) => {
    const service = connected(root);
    let requestSignal: AbortSignal | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        await service.activate("fixture-client");
        requestSignal!.throwIfAborted();
        return sse(textEvents());
    }) as typeof fetch;
    const resolved = resolveChatGPTModel("chatgpt:fixture-model", service, fetcher);
    const result = streamText({ model: resolved.model, prompt: "fixture", providerOptions: resolved.providerOptions, maxRetries: 0, onError: () => {} });
    const errors = [];
    for await (const event of result.fullStream) if (event.type === "error" || event.type === "abort") errors.push(event);
    expect(requestSignal?.aborted).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
}));

test.each(["Text/Event-Stream; Charset=UTF-8", "text/plain", "application/octet-stream", "application/json", ""])("ChatGPT negotiates SSE and reads valid events with Content-Type %s", contentType => withFixture(async ({ root }) => {
    const service = connected(root);
    let calls = 0;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
        calls++;
        // Reproduz um gateway que responde JSON quando o cliente não pede SSE.
        if (new Headers(init?.headers).get("Accept") !== "text/event-stream") {
            return Response.json({ error: { code: "event_stream_required", message: "fixture-private-message" } });
        }
        const source = sse(textEvents());
        return new Response(source.body, { headers: contentType ? { "Content-Type": contentType } : {} });
    }) as typeof fetch;
    const resolved = resolveChatGPTModel("chatgpt:fixture-model", service, fetcher);
    const result = streamText({ model: resolved.model, prompt: "fixture", providerOptions: resolved.providerOptions, maxRetries: 0, onError: () => {} });
    for await (const event of result.fullStream) if (event.type === "error") throw event.error;
    expect(await result.text).toBe("Resposta fixture");
    expect(calls).toBe(1);
})());

test("JSON plan errors with HTTP 200 are distinguished from SSE without exposing the body", async () => {
    const result = requireCompletedChatGPTStream(Response.json({ error: {
        code: "subscription_sharing_usage_limit_exceeded", message: "fixture-private-message",
    } }));
    const error = await result.text().catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("limite");
    expect((error as Error).message).not.toContain("fixture-private-message");
});

test("HTML and empty responses are rejected with safe protocol diagnostics", async () => {
    await expect(requireCompletedChatGPTStream(new Response("<html>fixture-private-message</html>", { headers: { "Content-Type": "text/html" } })).text())
        .rejects.toThrow("HTTP 200; Content-Type text/html");
    expect(() => requireCompletedChatGPTStream(new Response(null))).toThrow("HTTP 200");
});

test.each(["Text/Event-Stream; charset=UTF-8", "application/octet-stream", ""])("SSE content is validated independently of the MIME header: %s", async mime => {
    const source = sse(textEvents());
    const normalized = requireCompletedChatGPTStream(new Response(source.body, { headers: mime ? { "Content-Type": mime } : {} }));
    expect(normalized.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await normalized.text()).toContain("response.completed");
});

test.each(["\r\n", "\r"])("SSE validation supports the line delimiter %j", async delimiter => {
    const source = `: keepalive${delimiter}event: response.completed${delimiter}data: {"type":"response.completed","response":{"status":"completed"}}${delimiter}${delimiter}`;
    expect(await requireCompletedChatGPTStream(new Response(source)).text()).toContain("response.completed");
});

test("oversized non-SSE JSON is cancelled while reading and never treated as a completion", async () => {
    let cancelled = false;
    let chunks = 0;
    const source = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new TextEncoder().encode(chunks++ === 0 ? '{"error":"' : "x".repeat(1024))); },
        cancel() { cancelled = true; },
    });
    await expect(requireCompletedChatGPTStream(new Response(source, { headers: { "Content-Type": "application/json" } })).text()).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThan(100);
    await expect(requireCompletedChatGPTStream(Response.json({ status: "completed", output: [] })).text()).rejects.toThrow("fora do formato SSE");
});
