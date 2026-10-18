import { expect, mock, test } from "bun:test";
import type { ModelMessage } from "ai";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadFileTool } from "../tools/read-file";
import { execute, withFixture } from "../test-support";
import { CONTEXT_OMISSION_NOTE, contextFromMessages, DEFAULT_CONTEXT_TOKEN_LIMIT, estimateContextTokens,
    fitContextWindow, persistSessionContext, refreshSessionContext } from "./session-context";

test("context reconstructs tool pairs, omits reasoning and marks unfinished calls", () => {
    const messages = contextFromMessages([
        { role: "USER", status: "COMPLETE", content: "inspect" },
        { role: "ASSISTANT", status: "INTERRUPTED", content: "", parts: [
            { type: "reasoning", text: "fixture private reasoning" },
            { type: "tool-call", id: "a", name: "read_file", args: { path: "a" } },
            { type: "tool-result", id: "a", name: "read_file", result: "saved result" },
            { type: "tool-call", id: "b", name: "write_file", args: { path: "b" } },
        ] },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("fixture private reasoning");
    expect(serialized).toContain("saved result");
    expect(serialized).toContain("Não repetir automaticamente");
    const call = messages.find(m => m.role === "assistant" && Array.isArray(m.content) && m.content.some(p => p.type === "tool-call"));
    expect(call).toMatchObject({ role: "assistant", content: [{ type: "tool-call", toolCallId: "a" }] });
    expect(messages.find(m => m.role === "tool")).toMatchObject({ content: [{ toolCallId: "a" }] });
});

test("rolling context keeps the latest user intact and never leaves orphan tool results", () => {
    const history: ModelMessage[] = [
        { role: "user", content: "old request" },
        { role: "assistant", content: "x".repeat(4_000) },
        { role: "user", content: "current request" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "read_file", input: { path: "a" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "read_file", output: { type: "text", value: "saved result" } }] },
    ];
    const result = fitContextWindow(history, 512);
    expect(result.estimatedTokens).toBeLessThanOrEqual(512);
    expect(result.truncated).toBe(true);
    expect(result.messages[0]).toEqual({ role: "user", content: "current request" });
    expect(result.messages).toContainEqual({ role: "assistant", content: CONTEXT_OMISSION_NOTE });
    expect(result.messages.at(-1)?.role).toBe("tool");
    expect(fitContextWindow(result.messages, 512).messages).toEqual(result.messages);
});

test("oversized current user is rejected instead of silently truncated", () => {
    expect(() => fitContextWindow([{ role: "user", content: "x".repeat(60_000) }])).toThrow("CONTEXT_MESSAGE_TOO_LARGE");
    expect(DEFAULT_CONTEXT_TOKEN_LIMIT).toBe(16_384);
});

test("large live tool output is excerpted while its call/result pair remains intact", () => {
    const window = fitContextWindow([
        { role: "user", content: "inspect" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "read_file", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "read_file", output: { type: "json", value: { text: "x".repeat(60_000) } } }] },
    ]);
    expect(window.truncated).toBe(true);
    expect(window.estimatedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_TOKEN_LIMIT);
    expect(window.messages.at(-1)).toMatchObject({ role: "tool", content: [{ toolCallId: "a", output: { type: "text" } }] });
});

test("provider reasoning needed within a live generation keeps its metadata", () => {
    const window = fitContextWindow([
        { role: "user", content: "request" },
        { role: "assistant", content: [{ type: "reasoning", text: "fixture", providerOptions: { fixture: { signature: "fixture-signature" } } }] },
    ]);
    expect(JSON.stringify(window.messages)).toContain("fixture-signature");
});

test("oversized tool args become explicit evidence instead of an incomplete executable pair", () => {
    const messages = contextFromMessages([{ role: "USER", content: "do task", status: "COMPLETE" }, { role: "ERROR", content: "error", status: "COMPLETE", parts: [
        { type: "tool-call", id: "a", name: "write_file", args: { content: "x".repeat(9_000) } },
        { type: "tool-result", id: "a", name: "write_file", result: "written" },
    ] }]);
    expect(JSON.stringify(messages)).toContain("argumentos omitidos");
    expect(JSON.stringify(messages)).toContain("written");
    expect(messages.some(m => m.role === "tool")).toBe(false);
});

test("snapshot returned by persistence is what the model receives; cancellation prevents writes", async () => {
    const upsert = mock(async ({ create }: { create: Record<string, unknown> }) => ({ ...create, messages: [{ role: "user", content: "database snapshot" }] }));
    const db = { sessionContext: { findUnique: async () => null, upsert } } as unknown as Parameters<typeof persistSessionContext>[0];
    expect(await persistSessionContext(db, "s", [{ role: "user", content: "request" }])).toEqual([{ role: "user", content: "database snapshot" }]);
    expect(upsert).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(persistSessionContext(db, "s", [], controller.signal)).rejects.toThrow("cancelled");
    expect(upsert).toHaveBeenCalledTimes(1);
});

test("refresh reads a bounded recent history and reuses the persisted session limit", async () => {
    const findMany = mock(async (_args: unknown) => [{ role: "USER", content: "newest", status: "COMPLETE", parts: null }]);
    let saved: Record<string, unknown> = {};
    const db = { message: { findMany }, sessionContext: {
        findUnique: async () => ({ tokenLimit: 1_024 }),
        upsert: async ({ create }: { create: Record<string, unknown> }) => { saved = create; return create; },
    } } as unknown as Parameters<typeof persistSessionContext>[0];
    expect(await refreshSessionContext(db, "s")).toEqual([{ role: "user", content: "newest" }]);
    expect(findMany.mock.calls[0]).toMatchObject([{ where: { sessionId: "s" }, take: 81 }]);
    expect(saved.tokenLimit).toBe(1_024);
    expect(saved.estimatedTokens).toBe(estimateContextTokens([{ role: "user", content: "newest" }]));
});


for (const encoding of ["json", "text"] as const) {
    test(`read_file pages reach the next model step intact as ${encoding}`, () => {
        const page = { path: "a", content: Array.from({ length: 75 }, (_, i) => `${i + 1}: ${"x".repeat(80)}`).join("\n"),
            totalLines: 100, truncated: true, nextOffset: 75, continuation: "Continue com offset=75 e limit=75." };
        const output = encoding === "json" ? { type: "json" as const, value: page } : { type: "text" as const, value: JSON.stringify(page) };
        const messages: ModelMessage[] = [
            { role: "user", content: "inspect" },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "page", toolName: "read_file", input: { path: "a" } }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "page", toolName: "read_file", output }] },
        ];
        const window = fitContextWindow(messages);
        expect(window.messages.at(-1)).toEqual(messages.at(-1));
        expect(window.truncated).toBe(false);
        expect(window.estimatedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_TOKEN_LIMIT);
        const small = fitContextWindow(messages, 512);
        expect(small.messages).toEqual([{ role: "user", content: "inspect" }, { role: "assistant", content: CONTEXT_OMISSION_NOTE }]);
        expect(small.truncated).toBe(true);
    });
}

test("persisted read_file pages survive reload without middle excerpts", () => {
    const page = { path: "a", content: "line\n".repeat(1_500), totalLines: 2_000, truncated: true, nextOffset: 1_500 };
    const serialized = JSON.stringify(page);
    const messages = contextFromMessages([{ role: "USER", status: "COMPLETE", content: "inspect" }, {
        role: "ASSISTANT", status: "COMPLETE", content: "", parts: [
            { type: "tool-call", id: "page", name: "read_file", args: { path: "a" } },
            { type: "tool-result", id: "page", name: "read_file", result: serialized },
        ],
    }]);
    expect(fitContextWindow(messages).messages.at(-1)).toEqual({ role: "tool", content: [
        { type: "tool-result", toolCallId: "page", toolName: "read_file", output: { type: "text", value: serialized } },
    ] });
});


test("real read_file pagination reaches the model without missing middle lines", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "a"), Array.from({ length: 100 }, () => "x".repeat(100)).join("\r\n"));
    const page = await execute(createReadFileTool(cwd), { path: "a" });
    const serialized = JSON.stringify(page);
    expect(serialized.length).toBeGreaterThan(4_000);
    expect(page.nextOffset).toBeGreaterThan(0);
    const result = { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "page", toolName: "read_file", output: { type: "text" as const, value: serialized } }] };
    const window = fitContextWindow([
        { role: "user", content: "inspect" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "page", toolName: "read_file", input: { path: "a" } }] }, result,
    ]);
    expect(window.messages.at(-1)).toEqual(result);
}));

test("read_file with oversized arguments omits its page instead of cutting its middle", () => {
    const messages = contextFromMessages([{ role: "USER", status: "COMPLETE", content: "inspect" }, {
        role: "ASSISTANT", status: "COMPLETE", content: "", parts: [
            { type: "tool-call", id: "page", name: "read_file", args: { path: "a".repeat(9_000) } },
            { type: "tool-result", id: "page", name: "read_file", result: JSON.stringify({ path: "a", content: "x".repeat(9_000), totalLines: 1, truncated: false }) },
        ],
    }]);
    const serialized = JSON.stringify(fitContextWindow(messages).messages);
    expect(serialized).toContain("caminho relativo menor");
    expect(serialized).not.toContain("[conteúdo abreviado]");
    expect(messages.some(message => message.role === "tool")).toBe(false);
});
