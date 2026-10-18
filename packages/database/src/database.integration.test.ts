import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, LocalAdapter } from "./client";
import { removeTestDatabase } from "./test-cleanup";
import { PrismaClient } from "../generated/prisma/client";
import type { Message, Session } from "../generated/prisma/client";
import { DEFAULT_CHAT_MODEL_ID } from "../../shared/src";
import { createSessionRoutes } from "../../server/src/routes/sessions";
import { deleteInactiveSessions, loadSessionForUse, SESSION_RETENTION_MS } from "../../server/src/services/session-lifecycle";
import { refreshSessionContext, persistSessionContext, DEFAULT_CONTEXT_TOKEN_LIMIT } from "../../server/src/services/session-context";

const fixtureHome = mkdtempSync(join(tmpdir(), "myagent-db-integration-"));
const connectionString = pathToFileURL(join(fixtureHome, "myagent.db")).href;
beforeAll(async () => { const database = await openDatabase({ home: fixtureHome }); await database.close(); });
afterAll(() => removeTestDatabase(fixtureHome));
type SessionHistory = Session & { messages: Message[] };
function client() {
    return new PrismaClient({ adapter: new LocalAdapter({ url: connectionString }) });
}
const headers = { "Content-Type": "application/json" };

test.skipIf(!connectionString)("SQLite local: context survives reload, preserves results and cascades", async () => {
    const db = client(), reader = client();
    const ids = [`context-${randomUUID()}`, `context-${randomUUID()}`];
    try {
        const response = await app(db).request("http://127.0.0.1:3000/", { method: "POST", headers, body: JSON.stringify({ title: "Context fixture" }) });
        expect(response.status).toBe(201);
        ids[0] = (await response.json() as SessionHistory).id;
        expect(await db.sessionContext.findUnique({ where: { sessionId: ids[0]! } })).toMatchObject({ tokenLimit: DEFAULT_CONTEXT_TOKEN_LIMIT, messages: [] });
        await db.session.create({ data: { id: ids[1]!, title: "Other session", userId: "local-user", workspacePath: fixtureHome } });
        const time = Date.now();
        await db.message.create({ data: { sessionId: ids[0]!, role: "USER", status: "COMPLETE", model: DEFAULT_CHAT_MODEL_ID, mode: "PLAN", content: "inspect", createdAt: new Date(time) } });
        await db.message.create({ data: { sessionId: ids[0]!, role: "ASSISTANT", status: "INTERRUPTED", model: DEFAULT_CHAT_MODEL_ID, mode: "PLAN", content: "", createdAt: new Date(time + 1), parts: [
            { type: "tool-call", id: "fixture-call", name: "read_file", args: { path: "a.txt" } },
            { type: "tool-result", id: "fixture-call", name: "read_file", result: "persistent result" },
        ] } });
        const snapshot = await refreshSessionContext(db, ids[0]!);
        expect(JSON.stringify(snapshot)).toContain("persistent result");
        await db.$disconnect();
        expect((await reader.sessionContext.findUnique({ where: { sessionId: ids[0]! } }))!.messages).toEqual(JSON.parse(JSON.stringify(snapshot)));
        await persistSessionContext(reader, ids[1]!, [
            { role: "user", content: "old" }, { role: "assistant", content: "x".repeat(60_000) }, { role: "user", content: "latest" },
        ]);
        expect((await reader.sessionContext.findUnique({ where: { sessionId: ids[1]! } }))!.estimatedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_TOKEN_LIMIT);
        expect((await reader.sessionContext.findUnique({ where: { sessionId: ids[0]! } }))!.messages).toEqual(JSON.parse(JSON.stringify(snapshot)));
        await reader.session.delete({ where: { id: ids[0]! } });
        expect(await reader.sessionContext.findUnique({ where: { sessionId: ids[0]! } })).toBeNull();
    } finally {
        try { await reader.session.deleteMany({ where: { id: { in: ids } } }); }
        finally { await Promise.all([db.$disconnect(), reader.$disconnect()]); }
    }
}, 20_000);

test("SQLite local: retention warning, renewal, disable and cascade", async () => {
    const db = client(), now = new Date();
    const stale = new Date(now.getTime() - SESSION_RETENTION_MS - 1);
    const ids = [randomUUID(), randomUUID()];
    const previous = process.env.MYAGENT_SESSION_RETENTION_DAYS;
    try {
        delete process.env.MYAGENT_SESSION_RETENTION_DAYS;
        for (const id of ids) await db.session.create({ data: { id, title: "retention", userId: "local-user", workspacePath: fixtureHome, updatedAt: stale,
            messages: { create: { role: "USER", status: "COMPLETE", model: DEFAULT_CHAT_MODEL_ID, mode: "PLAN", content: "saved", createdAt: stale } } } });
        expect((await deleteInactiveSessions(db, now)).count).toBe(0);
        expect((await db.session.findUnique({ where: { id: ids[0]! } }))?.retentionWarnedAt).toEqual(now);
        expect(await loadSessionForUse(db, ids[0]!, now)).not.toBeNull();
        expect((await db.session.findUnique({ where: { id: ids[0]! } }))?.retentionWarnedAt).toBeNull();
        process.env.MYAGENT_SESSION_RETENTION_DAYS = "0";
        expect((await deleteInactiveSessions(db, new Date(now.getTime() + 86400000))).count).toBe(0);
        process.env.MYAGENT_SESSION_RETENTION_DAYS = "90";
        expect((await deleteInactiveSessions(db, new Date(now.getTime() + 86400000))).count).toBe(1);
        expect(await db.message.count({ where: { sessionId: ids[1]! } })).toBe(0);
        expect(await db.session.findUnique({ where: { id: ids[0]! } })).not.toBeNull();
    } finally {
        if (previous === undefined) delete process.env.MYAGENT_SESSION_RETENTION_DAYS; else process.env.MYAGENT_SESSION_RETENTION_DAYS = previous;
        await db.session.deleteMany({ where: { id: { in: ids } } }); await db.$disconnect();
    }
}, 20000);

function app(db: PrismaClient) {
    return createSessionRoutes(db);
}

test.skipIf(!connectionString)("SQLite local: POST /session persists messages and another client reloads them", async () => {
    const db = client();
    const reader = client();
    let id: string | undefined;
    try {
        const initialMessage = { role: "USER", content: "Mensagem de integração", mode: "PLAN", model: DEFAULT_CHAT_MODEL_ID };
        const response = await app(db).request("http://127.0.0.1:3000/", {
            method: "POST", headers, body: JSON.stringify({ title: "Integração SQLite", initialMessage }),
        });
        expect(response.status).toBe(201);
        const session = await response.json() as SessionHistory;
        id = session.id;
        expect(session.userId).toBe("local-user");
        expect(session.messages).toHaveLength(1);
        expect(session.messages[0]).toMatchObject({ ...initialMessage, status: "COMPLETE" });
        const parts = [{ type: "text", text: "Resposta persistida" }];
        await db.message.create({ data: {
            sessionId: id!, role: "ASSISTANT", status: "COMPLETE", model: DEFAULT_CHAT_MODEL_ID,
            mode: "PLAN", content: "Resposta persistida", parts,
        } });
        await db.$disconnect();

        const reloaded = await app(reader).request(`http://127.0.0.1:3000/${id}`, { headers });
        expect(reloaded.status).toBe(200);
        const history = await reloaded.json() as SessionHistory;
        expect(history.messages).toHaveLength(2);
        expect(history.messages.find(message => message.role === "ASSISTANT")?.parts).toEqual(parts);
        await reader.session.delete({ where: { id } });
        expect(await reader.message.count({ where: { sessionId: id } })).toBe(0);
        id = undefined;
    } finally {
        try {
            if (id) await reader.session.deleteMany({ where: { id } });
        } finally {
            await Promise.all([db.$disconnect(), reader.$disconnect()]);
        }
    }
}, 20_000);

test.skipIf(!connectionString)("SQLite local: failed transaction does not leave a partial session", async () => {
    const db = client();
    const id = `integration-${randomUUID()}`;
    try {
        await expect(db.$transaction(async tx => {
            await tx.session.create({ data: { id, title: "Rollback", userId: "local-user", workspacePath: fixtureHome, messages: {
                create: { role: "USER", status: "COMPLETE", model: DEFAULT_CHAT_MODEL_ID, content: "Teste", mode: "PLAN" },
            } } });
            throw new Error("fixture rollback");
        })).rejects.toThrow("fixture rollback");
        expect(await db.session.findUnique({ where: { id } })).toBeNull();
        expect(await db.message.count({ where: { sessionId: id } })).toBe(0);
    } finally {
        try { await db.session.deleteMany({ where: { id } }); }
        finally { await db.$disconnect(); }
    }
}, 20_000);


test("SQLite local: many continuations keep the original user anchor and completed tool evidence", async () => {
    const db = client(), id = randomUUID();
    const time = Date.now();
    try {
        await db.session.create({ data: { id, userId: "local-user", title: "continued", workspacePath: fixtureHome } });
        await db.message.create({ data: { sessionId: id, role: "USER", status: "COMPLETE", model: "fixture", mode: "BUILD", content: "original request", createdAt: new Date(time) } });
        await db.message.createMany({ data: Array.from({ length: 81 }, (_, i) => ({ sessionId: id, role: "ASSISTANT" as const, status: "INTERRUPTED" as const,
            model: "fixture", mode: "BUILD" as const, content: "", createdAt: new Date(time + i + 1), parts: [
                { type: "tool-call", id: String(i), name: "edit_file", args: { path: "a", old_str: String(i), new_str: String(i + 1) }, execution: "started" },
                { type: "tool-result", id: String(i), name: "edit_file", result: `saved evidence ${i}` },
            ] })) });
        const history = await refreshSessionContext(db, id, undefined, 100000);
        expect(history[0]).toEqual({ role: "user", content: "original request" });
        expect(JSON.stringify(history)).toContain("saved evidence 80");
        expect((await db.sessionContext.findUniqueOrThrow({ where: { sessionId: id } })).truncated).toBe(true);
    } finally { await db.session.deleteMany({ where: { id } }); await db.$disconnect(); }
}, 20000);
