import { expect, test } from "bun:test";
import { asSchema, streamText, tool } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DEFAULT_CLOUD_CONTEXT_WINDOW } from "@myagent/shared";
import { resolveContextWindow, readModelPreferences, writeModelPreferences } from "../lib/context-window";
import { ChatGPTService } from "../lib/chatgpt";
import { ChatGPTStore } from "../lib/chatgpt-store";
import { CHATGPT_CONTEXT_OPTIONS } from "../lib/providers/chatgpt";
import { contextBudget, ContextBudgetError, measureToolDefinitions } from "./session-context";
import { prepareGenerationContext } from "./context-plan";
import { withFixture } from "../test-support";

test("unknown ChatGPT window is estimated above 16k; only exact catalog IDs and safe dated snapshots inherit windows", withFixture(async () => {
    const unknown = resolveContextWindow("chatgpt:gpt-5.6-luna");
    expect(unknown).toMatchObject({ contextWindow: DEFAULT_CLOUD_CONTEXT_WINDOW, contextWindowEstimated: true, contextWindowSource: "default" });
    expect(unknown.contextWindow).toBeGreaterThan(16_384);
    expect(resolveContextWindow("chatgpt:gpt-5.4")).toMatchObject({ contextWindow: 1_050_000, contextWindowEstimated: false });
    expect(resolveContextWindow("chatgpt:gpt-5.4-2026-03-01")).toMatchObject({ contextWindow: 1_050_000, contextWindowEstimated: true, contextWindowSource: "family" });
    expect(resolveContextWindow("chatgpt:gpt-5.4-unrelated").contextWindow).toBe(DEFAULT_CLOUD_CONTEXT_WINDOW);
    expect(resolveContextWindow("unlisted", { provider: "google" }).contextWindow).toBe(DEFAULT_CLOUD_CONTEXT_WINDOW);
}));

test("private preferences override ChatGPT and catalog IDs; custom defaults stay small and configurable, invalid preferences fail clearly", withFixture(async ({ root }) => {
    const path = join(root, "global", "model-preferences.json");
    writeModelPreferences({ contextWindows: { "chatgpt:gpt-5.6-luna": 131_072, "gpt-5.4": 65_536 }, defaultLocalContextWindow: 8192 });
    expect(resolveContextWindow("chatgpt:gpt-5.6-luna")).toMatchObject({ contextWindow: 131_072, contextWindowSource: "override" });
    expect(resolveContextWindow("gpt-5.4").contextWindow).toBe(65_536);
    expect(resolveContextWindow("custom", { provider: "ollama" }).contextWindow).toBe(8192);
    await writeFile(join(root, "global", "models.json"), JSON.stringify([{ id: "cloud-custom", provider: "openai" }]));
    expect(resolveContextWindow("cloud-custom").contextWindow).toBe(8192);
    await writeFile(join(root, "global", "models.json"), JSON.stringify([{ id: "gpt-5.4", provider: "ollama" }]));
    expect(resolveContextWindow("gpt-5.4").contextWindow).toBe(65_536); // preferência explícita ainda tem precedência
    expect(resolveContextWindow("constructor").contextWindow).toBe(8192);
    expect((await prepareGenerationContext({ modelId: "constructor", cwd: null, mode: "PLAN", sessionId: "safe-key" })).budget.tokenLimit).toBeGreaterThan(128);
    const store = new ChatGPTStore(join(root, "fixture-chatgpt.json"));
    store.write({ hostId: "urn:uuid:fixture", activeId: "fixture", accounts: [{ clientId: "fixture", subject: "fixture", label: "fixture", models: [{ slug: "gpt-5.6-luna", name: "Fixture Luna" }],
        tokens: { access: "fixture", refresh: "fixture", id: "fixture", expiresAt: Date.now() + 60000, scopes: [] } }] });
    expect(new ChatGPTService({ enabled: () => true, store }).models()[0]).toMatchObject({ contextWindow: 131_072, contextWindowEstimated: true });
    for (const value of [0, -1, 1.5, 1023, "128000", 2_147_483_648]) expect(() => writeModelPreferences({ contextWindows: { "chatgpt:x": value } })).toThrow();
    await writeFile(path, "{corrompido");
    expect(() => readModelPreferences()).toThrow("model-preferences.json inválido");
}));

function thirtyTools() {
    return Object.fromEntries(Array.from({ length: 30 }, (_, index) => ["tool_" + index, tool({
        description: "Ferramenta de fixture com entrada tipada e limites explícitos.",
        inputSchema: z.object({ path: z.string().min(1).max(200), offset: z.number().int().nonnegative().default(0), include: z.array(z.string()).optional() }),
        providerOptions: CHATGPT_CONTEXT_OPTIONS.toolOptions, execute: async () => "fixture",
    })]));
}
test("tool estimation uses real SDK JSON schemas within 10%, caches a tool set and ignores internal cycles", async () => {
    const tools = thirtyTools();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    Object.assign(tools.tool_0!, { internalFixture: cycle });
    expect(measureToolDefinitions(tools)).toBe(measureToolDefinitions(tools));
    const measurement = await measureToolDefinitions(tools);
    let realTokens = 0;
    const provider = new MockLanguageModelV3({ doStream: async options => {
        realTokens = Math.ceil(Buffer.byteLength(JSON.stringify(options.tools), "utf8") / 3);
        return { stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } } }]) };
    } });
    for await (const _ of streamText({ model: provider, prompt: "fixture", tools }).fullStream) { /* consome o SDK real */ }
    expect(realTokens).toBeGreaterThan(0);
    expect(Math.abs(measurement.tokens - realTokens) / realTokens).toBeLessThan(0.1);
    expect(JSON.stringify(await asSchema(tools.tool_0!.inputSchema).jsonSchema)).not.toContain("internalFixture");
    const budget = await contextBudget(131_072, "prompt", tools, CHATGPT_CONTEXT_OPTIONS.providerOptions);
    expect(budget.toolCount).toBe(30); expect(budget.tokenLimit).toBeGreaterThan(60_000);
    await expect(contextBudget(1024, "sistema ".repeat(1000), tools, undefined, true)).rejects.toBeInstanceOf(ContextBudgetError);
    await expect(contextBudget(1024, "sistema ".repeat(1000), tools, undefined, true)).rejects.toThrow(/1024 tokens \(estimada\).*30 ferramentas.*Configure contextWindow/);
});

test.each(["PLAN", "BUILD"] as const)("16k %s uses only essential tools and leaves a useful budget; 128k keeps 30 tools", mode => withFixture(async ({ cwd }) => {
    writeModelPreferences({ contextWindows: { "chatgpt:gpt-5.6-luna": 16_384 } });
    const small = await prepareGenerationContext({ modelId: "chatgpt:gpt-5.6-luna", cwd, mode, sessionId: "s", security: { sandboxAvailable: true } });
    expect(small.compact).toBe(true); expect(small.budget.tokenLimit).toBeGreaterThan(2048);
    expect(small.tools).toHaveProperty("read_file"); expect(small.tools).not.toHaveProperty("web_fetch"); expect(small.tools).not.toHaveProperty("project_inspect");
    expect(small.tools).not.toHaveProperty("git_push");
    expect(small.system).toContain(`Ferramentas disponíveis: ${Object.keys(small.tools!).join(", ")}.`);
    expect(small.system).toContain("Perfil compacto");
    expect(small.system).not.toContain("project_inspect");
    if (mode === "PLAN") { expect(small.tools).not.toHaveProperty("write_file"); expect(small.tools).not.toHaveProperty("git_commit"); expect(small.tools).not.toHaveProperty("bash"); }
    else { expect(small.tools).toHaveProperty("write_file"); expect(small.tools).toHaveProperty("git_commit"); expect(small.tools).toHaveProperty("bash"); }
    writeModelPreferences({ contextWindows: { "chatgpt:gpt-5.6-luna": 131_072 } });
    const large = await prepareGenerationContext({ modelId: "chatgpt:gpt-5.6-luna", cwd, mode, sessionId: "s", createTools: thirtyTools });
    expect(large.compact).toBe(false); expect(Object.keys(large.tools!)).toHaveLength(30);
    expect(large.budget.tokenLimit).toBeGreaterThan(60_000);
    const again = await prepareGenerationContext({ modelId: "chatgpt:gpt-5.6-luna", cwd, mode, sessionId: "s", createTools: thirtyTools, resolvedModel: { provider: "chatgpt", contextWindow: 16_384, ...CHATGPT_CONTEXT_OPTIONS } });
    expect(again.budget).toEqual(large.budget); expect(again.window).toEqual(large.window);
})());
