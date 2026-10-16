import { expect, test } from "bun:test";
import { abortable, boundedResponseText, toolDeadline } from "./tool-io";

test("stream byte limit stops reading immediately and cancels the body", async () => {
    let reads = 0, cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(30)); },
        cancel() { cancelled = true; },
    }));
    await expect(boundedResponseText(response, 50, new AbortController().signal)).rejects.toThrow("OUTPUT_LIMIT_REACHED");
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(3);
});

test("UTF-8 split between chunks is preserved", async () => {
    const bytes = new TextEncoder().encode("ação 🌎");
    const response = new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
    } }));
    expect(await boundedResponseText(response, bytes.length, new AbortController().signal)).toBe("ação 🌎");
});

test("abort cancels a pending body read and deadline is disposable", async () => {
    const parent = new AbortController();
    const deadline = toolDeadline(parent.signal, 10_000);
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const reading = boundedResponseText(response, 50, deadline.signal);
    parent.abort(new Error("fixture cancelled"));
    await expect(reading).rejects.toThrow("fixture cancelled");
    deadline.dispose();
    expect(cancelled).toBe(true);
});

test("deadline rejects non-settling work and dispose clears its timer", async () => {
    const deadline = toolDeadline(undefined, 10);
    await expect(abortable(new Promise(() => {}), deadline.signal)).rejects.toThrow("TOOL_TIMEOUT");
    deadline.dispose();
    const disposed = toolDeadline(undefined, 1);
    disposed.dispose();
    await Bun.sleep(5);
    expect(disposed.signal.aborted).toBe(false);
});
