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
        expect(chat.messages.at(-1)!.totalTokens).toBe(500);
    } finally {
        await act(async () => { ui.renderer.destroy(); });
    }
});
