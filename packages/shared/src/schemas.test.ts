import { test, expect } from "bun:test";
import { chatStreamEventSchema, messagePartsSchema, toolCallArgsSchema, messageContentSchema, MAX_MESSAGE_LENGTH, type MessageParts } from "./schemas";
import { SUPPORTED_CHAT_MODELS, DEFAULT_CHAT_MODEL_ID, findSupportedChatModel } from "./models";

test("messages accept 9000 characters and reject larger or empty input; push confirmation survives SSE schema", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(9000);
    expect(messageContentSchema.parse("x".repeat(9000))).toHaveLength(9000);
    expect(messageContentSchema.safeParse("x".repeat(9001)).success).toBe(false);
    expect(messageContentSchema.safeParse("  ").success).toBe(false);
    const approval = { type: "approval-required" as const, approvalId: "push", toolName: "git_push", args: { branch: "main", url: "https://github.com/o/r" }, confirmation: "main", allowSession: false };
    expect(chatStreamEventSchema.parse(approval)).toEqual(approval);
});
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

test("context notices and actionable context errors retain their fields in streaming and history", () => {
    const notice = { type: "context-warning" as const, contextWindow: 16384, estimated: true, toolCount: 12, message: "Perfil compacto" };
    expect(chatStreamEventSchema.parse(notice)).toEqual(notice);
    expect(messagePartsSchema.parse([notice])).toEqual([notice]);
    const error = { type: "error" as const, kind: "context" as const, message: "Configure contextWindow", messageId: "error", parts: [] };
    expect(chatStreamEventSchema.parse(error)).toEqual(error);
});
test("streaming validates approval and terminal event fields", () => {
    expect(chatStreamEventSchema.safeParse({ type: "approval-required", approvalId: "a", toolName: "bash", args: { command: "pwd" } }).success).toBe(true);
    expect(chatStreamEventSchema.safeParse({ type: "approval-required", toolName: "bash", args: {} }).success).toBe(false);
    const scoped = { type: "approval-required" as const, approvalId: "scoped", toolName: "edit_file", toolCallId: "call", args: { path: "a.ts" }, scope: "Caminhos: a.ts", allowSession: true };
    expect(chatStreamEventSchema.parse(scoped)).toEqual(scoped);
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
