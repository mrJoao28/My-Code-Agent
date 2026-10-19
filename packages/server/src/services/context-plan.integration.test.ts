import { expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { streamText, MockLanguageModelV3, convertArrayToReadableStream } from "../provider-test-support";
import { openDatabase } from "../../../database/src/client";
import { removeTestDatabase } from "../../../database/src/test-cleanup";
import { withFixture } from "../test-support";
import { handleSubmit, type ChatDependencies } from "./chat-service";
import { streamAIResponse } from "./stream-service";
import { resolveContextWindow, writeModelPreferences } from "../lib/context-window";
import { CHATGPT_CONTEXT_OPTIONS } from "../lib/providers/chatgpt";
import { chatStreamEventSchema, messagePartsSchema } from "@myagent/shared";

test.each([65_536, 16_384])("unknown ChatGPT model converses at %s through chat → stream → real SDK; budgets agree and compact notice survives reload", window => withFixture(async ({ cwd, root }) => {
    const modelId = "chatgpt:gpt-5.6-luna";
    if (window === 16_384) writeModelPreferences({ contextWindows: { [modelId]: window } });
    const home = join(root, "db");
    const database = await openDatabase({ home });
    const previousRoots = process.env.MYAGENT_WORKSPACE_ROOTS;
    process.env.MYAGENT_WORKSPACE_ROOTS = JSON.stringify([cwd]);
    let initialBudget = 0;
    const provider = new MockLanguageModelV3({ doStream: async options => {
        expect(options.tools?.length).toBeGreaterThan(0);
        if (window === 16_384) expect(options.tools?.some(tool => tool.name === "web_fetch")).toBe(false);
        expect(JSON.stringify(options.prompt)).toContain("Olá");
        return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] }, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "Olá, posso ajudar." }, { type: "text-end", id: "a" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
        ]) };
    } });
    try {
        const { db } = database;
        await db.session.create({ data: { id: "context-conversation", title: "fixture", userId: "local-user", cwd, workspacePath: cwd } });
        const dependencies: ChatDependencies = {
            db, validateSessionWorkspace: async () => cwd, isSupportedChatModel: (id: string): id is string => id === modelId, isModelConfigured: () => true, touchSession: async () => {},
            streamAIResponse: async (stream, params) => {
                initialBudget = (await db.sessionContext.findUniqueOrThrow({ where: { sessionId: params.sessionId } })).tokenLimit;
                await streamAIResponse(stream, params, { db, touchSession: async () => {}, generate: streamText,
                    resolveModel: () => ({ model: provider, provider: "chatgpt", modelId, ...resolveContextWindow(modelId), ...CHATGPT_CONTEXT_OPTIONS }),
                });
            },
        };
        const app = new Hono().post("/chat/:sessionId", c => handleSubmit(c, { content: "Olá", model: modelId, mode: "BUILD" }, dependencies));
        const response = await app.request("/chat/context-conversation", { method: "POST" });
        expect(response.status).toBe(200);
        const events = (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => chatStreamEventSchema.parse(JSON.parse(line.slice(5))));
        expect(events.some(event => event.type === "error")).toBe(false);
        expect(events.at(-1)?.type).toBe("done");
        expect(provider.doStreamCalls).toHaveLength(1);
        const saved = await db.message.findFirstOrThrow({ where: { sessionId: "context-conversation", role: "ASSISTANT" } });
        expect(saved.content).toBe("Olá, posso ajudar."); expect(saved.status).toBe("COMPLETE");
        const parts = messagePartsSchema.parse(saved.parts);
        expect(parts.some(part => part.type === "context-warning")).toBe(window === 16_384);
        expect(events.some(event => event.type === "context-warning")).toBe(window === 16_384);
        const context = await db.sessionContext.findUniqueOrThrow({ where: { sessionId: "context-conversation" } });
        expect(context.tokenLimit).toBe(initialBudget); expect(initialBudget).toBeGreaterThan(2048);
    } finally {
        if (previousRoots === undefined) delete process.env.MYAGENT_WORKSPACE_ROOTS; else process.env.MYAGENT_WORKSPACE_ROOTS = previousRoots;
        await database.close(); await removeTestDatabase(home);
    }
})(), 30_000);
