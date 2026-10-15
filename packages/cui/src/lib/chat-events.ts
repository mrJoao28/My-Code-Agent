import { EventSourceParserStream } from "eventsource-parser/stream";
import { chatStreamEventSchema, type ChatStreamEvent } from "@myagent/shared";

export async function* readChatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
    const decoder = new TextDecoder();
    const decode = new TransformStream<Uint8Array, string>({
        transform(chunk, controller) { controller.enqueue(decoder.decode(new Uint8Array(chunk), { stream: true })); },
        flush(controller) { const remaining = decoder.decode(); if (remaining) controller.enqueue(remaining); },
    });
    const events = body.pipeThrough(decode).pipeThrough(new EventSourceParserStream());
    for await (const { data } of events) {
        const event = chatStreamEventSchema.parse(JSON.parse(data));
        yield event;
        if (event.type === "done" || event.type === "error") return;
    }
    throw new Error("A conexão terminou antes de um evento final da geração.");
}
