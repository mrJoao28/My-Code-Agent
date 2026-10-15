import { test, expect } from "bun:test";
import { chatStreamEventSchema, messagePartsSchema, toolCallArgsSchema, type MessageParts } from "./schemas";
import { SUPPORTED_CHAT_MODELS, DEFAULT_CHAT_MODEL_ID, findSupportedChatModel } from "./models";
test("persisted parts retain reasoning, tool arguments/results and text", () => {
    const parts: MessageParts = [
        { type: "reasoning", text: "summary" },
        { type: "tool-call", id: "t", name: "read_file", args: { path: "a", nested: { count: 1 } } },
        { type: "tool-result", id: "t", name: "read_file", result: "content" },
        { type: "text", text: "done" },
    ];
    expect(messagePartsSchema.parse(parts)).toEqual(parts);
    expect(messagePartsSchema.safeParse([{ type: "tool-call", name: "missing-id" }]).success).toBe(false);
    expect(toolCallArgsSchema.safeParse({ invalid: undefined }).success).toBe(false);
});
test("streaming validates approval and terminal event fields", () => {
    expect(chatStreamEventSchema.safeParse({ type: "approval-required", approvalId: "a", toolName: "bash", args: { command: "pwd" } }).success).toBe(true);
    expect(chatStreamEventSchema.safeParse({ type: "approval-required", toolName: "bash", args: {} }).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({ type: "done", messageId: "m", durationMs: "10" }).success).toBe(false);
});
test("default model exists and built-in identifiers are unique", () => {
    expect(findSupportedChatModel(DEFAULT_CHAT_MODEL_ID)?.id).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(new Set(SUPPORTED_CHAT_MODELS.map(m => m.id)).size).toBe(SUPPORTED_CHAT_MODELS.length);
    expect(findSupportedChatModel("unsupported")).toBeUndefined();
});

test("usage events accept nonnegative integer totals and reject invalid accounting", () => {
    expect(chatStreamEventSchema.parse({ type: "usage", totalTokens: 1_250 })).toEqual({ type: "usage", totalTokens: 1_250 });
    for (const totalTokens of [-1, 1.5, Infinity, "1000", 2_147_483_648]) {
        expect(chatStreamEventSchema.safeParse({ type: "usage", totalTokens }).success).toBe(false);
    }
});
