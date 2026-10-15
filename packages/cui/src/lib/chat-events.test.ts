import { test, expect } from "bun:test";
import { readChatEvents } from "./chat-events";
import type { ChatStreamEvent } from "@myagent/shared";

function stream(chunks: string[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({ start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
    } });
}
test("SSE decodes fragmented events, approvals, tools and completion in order", async () => {
    const raw: ChatStreamEvent[] = [
        { type: "text-delta", text: "hello" },
        { type: "approval-required", approvalId: "a", toolName: "write_file", args: { path: "x" } },
        { type: "tool-call", toolCallId: "t", toolName: "write_file", args: { path: "x" } },
        { type: "tool-result", toolCallId: "t", toolName: "write_file", result: "ok" },
        { type: "usage", totalTokens: 1_250 },
        { type: "done", messageId: "m", durationMs: 10 },
    ];
    const encoded = raw.map(event => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join("");
    const chunks = encoded.match(/.{1,7}/gs)!;
    const received = [];
    for await (const event of readChatEvents(stream(chunks))) received.push(event);
    expect(received).toEqual(raw);
});
test("SSE preserves UTF-8 characters split across byte chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"type":"text-delta","text":"ação 🌎"}\n\ndata: {"type":"done","messageId":"m","durationMs":1}\n\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
        controller.close();
    } });
    const received: ChatStreamEvent[] = [];
    for await (const event of readChatEvents(body)) received.push(event);
    expect(received[0]).toEqual({ type: "text-delta", text: "ação 🌎" });
});
test("SSE supports error as terminal event and rejects malformed payloads", async () => {
    const result = [];
    for await (const event of readChatEvents(stream(['data: {"type":"error","message":"provider failed"}\n\n']))) result.push(event);
    expect(result).toEqual([{ type: "error", message: "provider failed" }]);
    for (const payload of ["invalid", '{"type":"unknown"}', '{"type":"tool-result","result":"missing call id"}']) {
        const consume = async () => { for await (const _event of readChatEvents(stream(["data: " + payload + "\n\n"]))) {} };
        await expect(consume()).rejects.toThrow();
    }
});
test("SSE never treats an EOF or a pending approval as successful completion", async () => {
    for (const payload of ["", 'data: {"type":"text-delta","text":"partial"}\n\n',
        'data: {"type":"approval-required","approvalId":"a","toolName":"bash","args":{}}\n\n']) {
        const consume = async () => { for await (const _event of readChatEvents(stream([payload]))) {} };
        await expect(consume()).rejects.toThrow("evento final");
    }
});
