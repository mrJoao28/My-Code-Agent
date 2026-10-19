import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { appClient } from "../lib/api-client";
import { useChat, type Message } from "./use-chat";

test.each(["done", "error", "interrupt", "eof"])("session token accounting handles %s without double counting", async ending => {
    let send!: (event: object) => void;
    let close!: () => void;
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
        send = event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        close = () => controller.close();
    } }));
    const client = { chat: { ":sessionId": { $post: async () => response } } } as unknown as typeof appClient;
    const initial: Message[] = [{ id: "old", role: "assistant", content: "previous", parts: [], mode: "PLAN", model: "fixture", totalTokens: 1_000 }];
    let chat!: ReturnType<typeof useChat>;
    function Harness() {
        chat = useChat("s", initial, client);
        return <text>{String(chat.totalTokens)}</text>;
    }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    let pending: Promise<void> | undefined;
    await act(async () => { ui = await testRender(<Harness />, { width: 40, height: 3 }); });
    try {
        expect(chat.totalTokens).toBe(1_000);
        await act(async () => { pending = chat.submit({ userText: "next", mode: "PLAN", model: "fixture" }); });
        await act(async () => { send({ type: "usage", totalTokens: 200 }); });
        await ui.waitFor(() => chat.totalTokens === 1_200);
        await act(async () => { send({ type: "usage", totalTokens: 500 }); });
        await ui.waitFor(() => chat.totalTokens === 1_500);
        if (ending === "done") {
            await act(async () => {
                send({ type: "tool-limit-warning", limit: 40 });
                send({ type: "text-delta", text: "Resumo parcial" });
            });
        }
        if (ending === "interrupt") {
            await act(async () => { chat.interrupt(); close(); await pending; });
        } else {
            await act(async () => {
                if (ending === "done") send({ type: "done", messageId: "saved", durationMs: 1 });
                if (ending === "error") send({ type: "error", message: "fixture failure" });
                close();
                await pending;
            });
        }
        expect(chat.streaming.status).toBe("idle");
        expect(chat.totalTokens).toBe(1_500);
        expect(chat.messages.filter(message => message.totalTokens === 500)).toHaveLength(1);
        if (ending === "done") {
            expect(chat.messages.at(-1)).toMatchObject({ role: "assistant", content: "Resumo parcial", parts: [
                { type: "tool-limit-warning", limit: 40 }, { type: "text", text: "Resumo parcial" },
            ] });
        }
    } finally {
        await act(async () => { ui.renderer.destroy(); });
    }
});


test("context budget errors with a saved message id are errors, never interrupted or pending resume", async () => {
    const message = "CONTEXT_MESSAGE_TOO_LARGE: A janela de 1024 tokens (estimada) não comporta 12 ferramentas. Configure contextWindow.";
    const events = [{ type: "generation-started", messageId: "context-error" }, { type: "error", kind: "context", messageId: "context-error", message, parts: [] }];
    const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    const client = { chat: { ":sessionId": { $post: async () => response } } } as unknown as typeof appClient;
    let chat!: ReturnType<typeof useChat>;
    function Harness() { chat = useChat("s", [], client); return <text>fixture</text>; }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<Harness />, { width: 60, height: 4 }); });
        await act(async () => { await chat.submit({ userText: "olá", mode: "BUILD", model: "fixture" }); });
        expect(chat.messages.at(-1)).toMatchObject({ id: "context-error", role: "error", content: message });
        expect(chat.pendingResume).toBeNull(); expect(chat.streaming.status).toBe("idle");
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});

test.each(["user", "interrupted"])("reload with pending %s asks before making any provider request", async kind => {
    let calls = 0;
    const client = { chat: { ":sessionId": { resume: { $post: async () => {
        calls++;
        return new Response(`data: ${JSON.stringify({ type: "done", messageId: "continued", durationMs: 0 })}\n\n`);
    } } } } } as unknown as typeof appClient;
    const initial: Message[] = kind === "user" ? [{ id: "u", role: "user", content: "next", mode: "BUILD", model: "fixture" }]
        : [{ id: "a", role: "assistant", content: "partial", mode: "BUILD", model: "fixture", parts: [{ type: "text", text: "partial" }], interrupted: true }];
    let chat!: ReturnType<typeof useChat>;
    function Harness() { chat = useChat("s", initial, client); return <text>{chat.pendingResume ? "Retomar a geração pendente?" : "Pronto"}</text>; }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<Harness />, { width: 60, height: 4 }); });
        expect(chat.pendingResume).not.toBeNull(); expect(calls).toBe(0);
        await act(async () => { await chat.confirmResume(); });
        expect(calls).toBe(1); expect(chat.pendingResume).toBeNull();
        expect(chat.messages.at(-1)?.id).toBe("continued");
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});

test("live interrupted tool snapshot equals persisted parts after reload", async () => {
    const { clientMessageParts } = await import("./use-chat");
    const parts = [
        { type: "tool-call" as const, id: "t", name: "edit_file", args: { path: "a", old_str: "old", new_str: "new" }, execution: "started" as const },
        { type: "tool-result" as const, id: "t", name: "edit_file", result: "saved" },
        { type: "text" as const, text: "partial" },
    ];
    const events = [{ type: "generation-started", messageId: "saved" }, { type: "tool-call", toolCallId: "t", toolName: "edit_file", args: parts[0]!.args },
        { type: "error", message: "Geração interrompida.", messageId: "saved", parts }];
    const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    const client = { chat: { ":sessionId": { $post: async () => response } } } as unknown as typeof appClient;
    let chat!: ReturnType<typeof useChat>;
    function Harness() { chat = useChat("s", [], client); return <text>fixture</text>; }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<Harness />, { width: 60, height: 4 }); });
        await act(async () => { await chat.submit({ userText: "edit", mode: "BUILD", model: "fixture" }); });
        expect(chat.messages.at(-1)).toMatchObject({ id: "saved", role: "assistant", interrupted: true, content: "partial", parts: clientMessageParts(parts) });
        expect(chat.pendingResume?.id).toBe("saved");
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});
