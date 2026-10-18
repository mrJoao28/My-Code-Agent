import { expect, mock, test } from "bun:test";
import type { ModelMessage } from "ai";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadFileTool } from "../tools/read-file";
import { execute, withFixture } from "../test-support";
import { SUMMARY_PREFIX, summarizeContext } from "./context-summary";
import { ToolCallGuard } from "./tool-service";
import { CONTEXT_OMISSION_NOTE, contextFromMessages, DEFAULT_CONTEXT_TOKEN_LIMIT, estimateContextTokens,
    contextBudget, fitContextWindow, persistSessionContext, refreshSessionContext } from "./session-context";

function reading(id: string, path = `${id}.ts`, content = Array.from({ length: 300 }, (_, i) => `${i + 1}: linha ${i} ${"x".repeat(15)}`).join("\n")): ModelMessage[] {
    return [
        { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path, offset: 0 } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "json", value: { path, content, totalLines: 300, truncated: false } } }] },
    ];
}

test("model budgets exceed the legacy ceiling and reserve system, tools and output", () => {
    const budget = contextBudget(200_000, "sistema ".repeat(1_000), { read: { description: "leitura" } });
    expect(budget.tokenLimit).toBeGreaterThan(16_384);
    expect(budget.tokenLimit + budget.responseTokens).toBeLessThan(200_000);
    expect(budget.tokenLimit).toBeLessThan(contextBudget(200_000).tokenLimit);
    const messages: ModelMessage[] = [{ role: "user", content: "x".repeat(60_000) }];
    expect(fitContextWindow(messages, budget.tokenLimit).messages).toEqual(messages);
    for (const invalid of [NaN, Infinity, 0, 1.5, -1]) expect(() => fitContextWindow([], invalid)).toThrow();
});

test("30 reads in one turn retain every complete page and do not cause a false loop", () => {
    const guard = new ToolCallGuard();
    const history: ModelMessage[] = [{ role: "user", content: "Leia os arquivos" }];
    const budget = contextBudget(200_000).tokenLimit;
    for (let i = 0; i < 30; i++) {
        guard.updateContext(fitContextWindow(history, budget).messages);
        guard.register("read_file", { path: `${i}.ts`, offset: 0 });
        history.push(...reading(String(i)));
    }
    const result = fitContextWindow(history, budget);
    expect(result.messages).toEqual(history);
    expect(result.truncated).toBe(false);
    expect(result.messages.filter(m => m.role === "tool")).toHaveLength(30);
});

test("results below the remaining budget are preserved regardless of tool name or size", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "busque" }, ...reading("search")];
    const call = messages[1]!, result = messages[2]!;
    if (call.role === "assistant" && Array.isArray(call.content) && call.content[0]?.type === "tool-call") call.content[0].toolName = "grep";
    if (result.role === "tool" && result.content[0]?.type === "tool-result") result.content[0].toolName = "grep";
    expect(fitContextWindow(messages, 50_000).messages).toEqual(messages);
});

test("read_file exhaustion cuts only at the end of whole lines with an exact continuation offset", () => {
    const original = Array.from({ length: 300 }, (_, i) => `${i + 41}: á漢😀 ${"x".repeat(15)}`).join("\n");
    const messages: ModelMessage[] = [{ role: "user", content: "leia" }, ...reading("page", "a.ts", original)];
    const call = messages[1]!;
    if (call.role === "assistant" && Array.isArray(call.content) && call.content[0]?.type === "tool-call") call.content[0].input = { path: "a.ts", offset: 40 };
    const before = JSON.stringify(messages);
    const window = fitContextWindow(messages, 2_000);
    const result = window.messages.find(m => m.role === "tool");
    expect(result?.role).toBe("tool");
    if (result?.role !== "tool" || result.content[0]?.type !== "tool-result" || result.content[0].output.type !== "text") throw new Error("missing page");
    const cut = JSON.parse(result.content[0].output.value);
    expect(cut.content.length).toBeGreaterThan(0);
    expect(cut.content).toBe(original.split("\n").slice(0, cut.nextOffset - 40).join("\n"));
    expect(cut.continuation).toContain(`offset=${cut.nextOffset}`);
    expect(cut.continuation).toContain("limit=");
    expect(window.estimatedTokens).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(messages)).toBe(before);
});

test("70 percent triggers an explicit summary of old evidence while the latest two turns stay intact", () => {
    const older: ModelMessage[] = [{ role: "user", content: "Corrigir a.ts; falta testar" }, ...reading("old")];
    older.push({ role: "assistant", content: "Decisão: preservar CRLF. Pendência: executar testes. " + "z".repeat(20_000) });
    const latest: ModelMessage[] = [{ role: "user", content: "Verifique b" }, ...reading("recent", "b.ts", "1: b"), { role: "user", content: "Continue" }];
    const window = fitContextWindow([...older, ...latest], 10_000);
    expect(window.truncated).toBe(true);
    expect(window.messages.filter(m => m.role === "user")).toEqual(latest.filter(m => m.role === "user"));
    expect(window.messages.slice(-3)).toEqual(latest.slice(-3));
    const summary = window.messages.find(m => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX));
    expect(JSON.stringify(summary)).toContain("old.ts");
    expect(JSON.stringify(summary)).toContain("preservar CRLF");
    expect(JSON.stringify(summary)).toContain("falta testar");
    expect(fitContextWindow(window.messages, 10_000).messages).toEqual(window.messages);
});

test("refresh preserves a compacted summary and accepts a larger explicit model budget", async () => {
    const summary = { role: "assistant" as const, content: SUMMARY_PREFIX + JSON.stringify({ read: ["old.ts"], changed: ["edit.ts"], decisions: [], pending: ["testar"] }) };
    let data: Record<string, unknown> = {};
    const db = { message: { findMany: async () => [{ role: "USER", content: "continue", status: "COMPLETE" }] }, sessionContext: {
        findUnique: async () => ({ tokenLimit: 1_024, messages: [{ role: "user", content: "old" }, summary] }),
        upsert: async ({ create }: { create: Record<string, unknown> }) => { data = create; return create; },
    } } as unknown as Parameters<typeof persistSessionContext>[0];
    const messages = await refreshSessionContext(db, "s", undefined, 150_000);
    expect(data.tokenLimit).toBe(150_000);
    expect(messages).toContainEqual(summary);
    expect(JSON.stringify(messages)).toContain("edit.ts");
});

test("summary distinguishes successful changes from failed or orphan writes and keeps pending todos", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "corrigir" }];
    for (const [id, failed] of [["ok", false], ["failed", true]] as const) {
        messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "edit_file", input: { path: `${id}.ts` } }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "edit_file", output: failed ? { type: "error-text", value: "denied" } : { type: "json", value: { success: true } } }] });
    }
    messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: "todo", toolName: "todo_write", input: { todos: [{ content: "testar", status: "pending" }, { content: "concluído", status: "completed" }] } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "todo", toolName: "todo_write", output: { type: "text", value: "saved" } }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "orphan", toolName: "write_file", input: { path: "orphan.ts" } }] });
    const message = summarizeContext(messages, 4_000);
    const summary = JSON.parse((message.content as string).slice(SUMMARY_PREFIX.length));
    expect(summary.changed).toEqual(["ok.ts"]);
    expect(summary.pending.join("\n")).toContain("testar");
    expect(summary.pending.join("\n")).not.toContain("concluído");
    expect(summary.pending.join("\n")).toContain("Falha em edit_file");
});

test("an empty cropped page never advances offset when fitted again", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "leia" }, ...reading("single", "a", "1: " + "x".repeat(9_000))];
    const first = fitContextWindow(messages, 512);
    const second = fitContextWindow(first.messages, 512);
    const result = second.messages.find(m => m.role === "tool");
    if (result?.role !== "tool" || result.content[0]?.type !== "tool-result" || result.content[0].output.type !== "text") throw new Error("missing page");
    const page = JSON.parse(result.content[0].output.value);
    expect(page.content).toBe("");
    expect(page.nextOffset).toBe(0);
    expect(page.continuation).toContain("grep");
    expect(second.messages).toEqual(first.messages);
});

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
        const last = small.messages.at(-1);
        if (last?.role === "tool" && last.content[0]?.type === "tool-result" && last.content[0].output.type === "text") {
            const cut = JSON.parse(last.content[0].output.value);
            expect(page.content.startsWith(cut.content)).toBe(true);
            expect(cut.continuation).toContain("offset=");
        }
        expect(small.estimatedTokens).toBeLessThanOrEqual(512);
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
