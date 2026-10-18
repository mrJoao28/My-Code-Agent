import { removeTestDatabase } from "../../../database/src/test-cleanup";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { openDatabase } from "../../../database/src/client";
import { withFixture as withWorkspaceFixture, type Fixture } from "../test-support";
import { handleResume, handleSubmit, type ChatDependencies } from "./chat-service";
import { streamAIResponse } from "./stream-service";
import { activeSessionGenerations, preventEffectReplay } from "./generation-journal";

// A coleta ocorre depois que a função do teste solta referências do adapter nativo.
function withFixture(fn: (fixture: Fixture) => Promise<void>) {
    return withWorkspaceFixture(async fixture => {
        try { await fn(fixture); }
        finally { await removeTestDatabase(join(fixture.root, "db")); }
    });
}

test.each(["submit", "resume"])("%s acquires the same lock before awaits and resume restores evidence without effects", first => withFixture(async ({ root, cwd }) => {
    const database = await openDatabase({ home: join(root, "db") });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let generations = 0;
    const previousRoots = process.env.MYAGENT_WORKSPACE_ROOTS;
    process.env.MYAGENT_WORKSPACE_ROOTS = JSON.stringify([cwd]);
    try {
        const { db } = database;
        await db.session.create({ data: { id: "race", title: "race", userId: "local-user", cwd, workspacePath: cwd } });
        await db.message.create({ data: { sessionId: "race", role: "USER", status: "COMPLETE", model: "fixture", mode: "BUILD", content: "write once", createdAt: new Date(Date.now() - 1000) } });
        await db.message.create({ data: { id: "root", sessionId: "race", generationId: "root", role: "ASSISTANT", status: "IN_PROGRESS", model: "fixture", mode: "BUILD", content: "", parts: [
            { type: "tool-call", id: "write", name: "write_file", args: { path: "saved", content: "once" }, execution: "started" },
            { type: "tool-result", id: "write", name: "write_file", result: "already saved evidence" },
        ] } });
        const dependencies: ChatDependencies = {
            db, validateSessionWorkspace: async () => { entered(); await gate; return cwd; },
            isSupportedChatModel: (model: string): model is string => Boolean(model), isModelConfigured: () => true, touchSession: async () => {},
            streamAIResponse: async (stream, params) => {
                generations++;
                if (first === "resume") {
                    expect(JSON.stringify(params.history)).toContain("already saved evidence");
                    expect(() => preventEffectReplay(params.previousParts ?? [], "write_file", { content: "once", path: "saved" })).toThrow("RETOMADA");
                    expect(params.generationId).toBe("root");
                    await streamAIResponse(stream, params, { db, touchSession: async () => {}, refreshContext: async () => {}, saveContext: async messages => messages,
                        resolveModel: () => ({ model: {} as never, modelId: "fixture", provider: "ollama" }),
                        generate: (() => ({ fullStream: (async function* () { yield { type: "text-delta", text: "Retomado sem repetir" }; })() })) as never,
                    });
                }
            },
        };
        const app = new Hono().post("/submit/:sessionId", c => handleSubmit(c, { content: "next", mode: "BUILD", model: "fixture" }, dependencies))
            .post("/resume/:sessionId", c => handleResume(c, dependencies));
        const pending = app.request(`/${first}/race`, { method: "POST" });
        await waiting;
        expect((await app.request("/submit/race", { method: "POST" })).status).toBe(409);
        expect((await app.request("/resume/race", { method: "POST" })).status).toBe(409);
        release();
        const response = await pending;
        expect(response.status).toBe(200); const events = await response.text();
        if (first === "resume") expect(events).toContain('"type":"done"');
        expect(generations).toBe(1);
        expect(activeSessionGenerations.has("race")).toBe(false);
        if (first === "resume") {
            expect((await db.message.findUniqueOrThrow({ where: { id: "root" } })).status).toBe("INTERRUPTED");
            expect(await db.message.count({ where: { generationId: "root" } })).toBe(2);
            expect(await db.message.count({ where: { generationId: "root", status: "COMPLETE" } })).toBe(1);
        }
    } finally {
        if (previousRoots === undefined) delete process.env.MYAGENT_WORKSPACE_ROOTS; else process.env.MYAGENT_WORKSPACE_ROOTS = previousRoots;
        release?.(); activeSessionGenerations.delete("race"); await database.close(); }
})(), 20000);
