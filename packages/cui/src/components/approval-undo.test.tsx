import { expect, test } from "bun:test";
import { act } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ThemeProvider } from "../providers/theme";
import { DialogProvider } from "../providers/dialog";
import { ToastProvider } from "../providers/toast";
import { PromptConfigProvider } from "../providers/prompt-config";
import { SessionShell } from "./session-shell";
import { testRender } from "@opentui/react/test-utils";
import { Hono } from "hono";
import { hc } from "hono/client";
import { streamSSE } from "hono/streaming";
import { streamText, MockLanguageModelV3, convertArrayToReadableStream } from "../../../server/src/provider-test-support";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { withFixture } from "../../../server/src/test-support";
import { streamAIResponse, type StreamDependencies } from "../../../server/src/services/stream-service";
import { handleUndo, type UndoDependencies } from "../../../server/src/services/chat-service";
import { createPermissionRoutes } from "../../../server/src/routes/permissions";
import { approvals } from "../../../server/src/security/permissions";
import { checkpoints } from "../../../server/src/security/checkpoints";
import { localAuthentication } from "../../../server/src/security/auth";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { ApprovalPanel } from "./approval-panel";
import { useChat } from "../hooks/use-chat";
import type { appClient } from "../lib/api-client";

test("simulated provider → CUI diff → approval HTTP → edit → /undo → persisted history and conflict", withFixture(async ({ cwd }) => {
    const roots = process.env.MYAGENT_WORKSPACE_ROOTS;
    process.env.MYAGENT_WORKSPACE_ROOTS = JSON.stringify([cwd]);
    await writeFile(join(cwd, "a.ts"), "before\r\n");
    const persisted: Record<string, unknown>[] = [];
    const database = {
        session: { findUnique: async () => ({ id: "e2e", cwd }), updateMany: async () => ({ count: 1 }) },
        message: { create: async ({ data }: { data: Record<string, unknown> }) => { persisted.push(data); return { id: `message-${persisted.length}` }; } },
    } as unknown as UndoDependencies["db"];
    let step = 0;
    const provider = new MockLanguageModelV3({ doStream: async () => {
        const final = step++ > 0;
        return { stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            ...(final ? [
                { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "Alteração concluída" }, { type: "text-end" as const, id: "answer" },
            ] : [{ type: "tool-call" as const, toolCallId: "edit", toolName: "edit_file", input: JSON.stringify({ path: "a.ts", old_str: "before", new_str: "after" }) }]),
            { type: "finish" as const, finishReason: { unified: final ? "stop" as const : "tool-calls" as const, raw: undefined },
                usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } } },
        ]) };
    } });
    const dependencies: StreamDependencies = { db: database, generate: streamText, resolveModel: () => ({ model: provider, provider: "ollama", modelId: "fixture", contextWindow: 200_000 }),
        saveContext: async messages => messages, refreshContext: async () => {}, touchSession: async () => {} };
    const app = new Hono().use("*", localAuthentication("x".repeat(40)))
        .route("/permissions", createPermissionRoutes())
        .post("/chat/:sessionId/undo", c => handleUndo(c, { db: database, store: checkpoints, validate: async () => cwd, touch: async () => {} }))
        .post("/chat/:sessionId", c => streamSSE(c, async stream => {
            const abortController = new AbortController(); stream.onAbort(() => abortController.abort());
            await streamAIResponse(stream, { sessionId: "e2e", cwd, mode: "BUILD", model: "fixture", history: [{ role: "user", content: "Edite a.ts" }], abortController }, dependencies);
        }));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 60 });
    const client = hc(server.url.toString(), { headers: { Authorization: "Bearer " + "x".repeat(40) } }) as unknown as typeof appClient;
    let chat!: ReturnType<typeof useChat>;
    let pending: Promise<void> | undefined;
    function Harness() {
        chat = useChat("e2e", [], client);
        return <SessionShell onSubmit={text => { pending = chat.submit({ userText: text, mode: "BUILD", model: "fixture" }); }} inputDisabled={!!chat.pendingApprovals.length || chat.undoing} loading={chat.streaming.status === "streaming"}>
            {chat.pendingApprovals[0] && <ApprovalPanel approval={chat.pendingApprovals[0]} decide={chat.decideApproval} interrupt={chat.interrupt} />}
            {chat.messages.map(message => <text key={message.id}>{message.content}</text>)}</SessionShell>;
    }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    const router = createMemoryRouter([{ path: "/", element: <ThemeProvider><KeyboardLayerProvider><ToastProvider><DialogProvider><PromptConfigProvider><Harness /></PromptConfigProvider></DialogProvider></ToastProvider></KeyboardLayerProvider></ThemeProvider> }]);
    try {
        await act(async () => { ui = await testRender(<RouterProvider router={router} />, { width: 110, height: 45 }); });
        await act(async () => { await ui.mockInput.typeText("Edite a.ts"); });
        await act(async () => { ui.mockInput.pressEnter(); });
        for (let attempt = 0; attempt < 200 && !chat.pendingApprovals.length && chat.streaming.status === "streaming"; attempt++) {
            await act(async () => { await Bun.sleep(20); });
        }
        expect(chat.messages.filter(message => message.role === "error")).toEqual([]);
        expect(chat.pendingApprovals).toHaveLength(1);
        await ui.waitForFrame(frame => frame.includes("-before") && frame.includes("+after"));
        expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("before\r\n");
        await act(async () => { ui.mockInput.pressEnter(); });
        expect(chat.pendingApprovals).toHaveLength(1);
        await act(async () => { await ui.mockInput.typeText("y"); });
        await act(async () => { await pending; });
        expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("after\r\n");
        expect(JSON.stringify(persisted)).toContain("checkpoint");
        await act(async () => { await ui.mockInput.typeText("/undo"); });
        await ui.waitForFrame(frame => frame.includes("Desfazer o último passo"));
        await act(async () => { ui.mockInput.pressEnter(); });
        await act(async () => { await pending; });
        expect(provider.doStreamCalls).toHaveLength(2);
        expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("before\r\n");
        expect(chat.messages.at(-1)?.content).toContain("Passo desfeito");
        expect(persisted.at(-1)?.content).toContain("[UNDO]");
        // Nova ação aprovada e edição externa: a API deve recusar o undo.
        await checkpoints.run(cwd, "e2e", "write_file", { path: "a.ts", content: "agent" }, async () => writeFile(join(cwd, "a.ts"), "agent"));
        await writeFile(join(cwd, "a.ts"), "user");
        await act(async () => { await chat.undo(); });
        expect(chat.messages.at(-1)?.content).toContain("Conflito");
        expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("user");
    } finally {
        approvals.forget("e2e");
        if (ui) await act(async () => { chat?.abort(); ui.renderer.destroy(); });
        router.dispose();
        await server.stop(true);
        if (roots === undefined) delete process.env.MYAGENT_WORKSPACE_ROOTS; else process.env.MYAGENT_WORKSPACE_ROOTS = roots;
    }
}), 30_000);
