import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import type { Message, Session } from "../generated/prisma/client";
import { DEFAULT_CHAT_MODEL_ID } from "../../shared/src";
import { createSessionRoutes } from "../../server/src/routes/sessions";
import { deleteInactiveSessions, loadSessionForUse, SESSION_RETENTION_MS } from "../../server/src/services/session-lifecycle";

const connectionString = process.env.MYAGENT_TEST_DATABASE_URL;
type SessionHistory = Session & { messages: Message[] };
function client() {
    const target = new URL(connectionString!);
    if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1"
        || target.pathname !== "/myagent_test" || target.username !== "myagent") {
        throw new Error("A integração exige um banco PostgreSQL local exclusivo chamado myagent_test.");
    }
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
const headers = { "Content-Type": "application/json" };

test.skipIf(!connectionString)("PostgreSQL Docker: retention honors the ten-day boundary, renewal and message cascade", async () => {
    const db = client();
    const now = new Date();
    const cutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
    const before = new Date(cutoff.getTime() - 1);
    const after = new Date(cutoff.getTime() + 1);
    const ids = Array.from({ length: 6 }, () => `retention-${randomUUID()}`);
    try {
        for (let index = 0; index < 5; index++) {
            await db.session.create({ data: {
                id: ids[index]!, userId: "local-user", title: "Retention fixture",
                createdAt: before, updatedAt: index === 2 || index === 4 ? after : index === 1 ? cutoff : before,
                messages: { create: { role: "USER", status: "COMPLETE", mode: "PLAN", model: DEFAULT_CHAT_MODEL_ID,
                    content: "Retention fixture", createdAt: index === 3 ? after : before } },
            } });
        }
        await db.session.create({ data: { id: ids[5]!, userId: "local-user", title: "Empty expired fixture", createdAt: before, updatedAt: before } });
        // Expiração é aplicada também antes do próximo ciclo de limpeza.
        expect(await loadSessionForUse(db, ids[1]!, now)).toBeNull();
        expect(await loadSessionForUse(db, ids[4]!, now)).not.toBeNull();
        await deleteInactiveSessions(db, now);
        expect(await db.session.findUnique({ where: { id: ids[0]! } })).toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[1]! } })).toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[5]! } })).toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[2]! } })).not.toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[3]! } })).not.toBeNull();
        // A sessão renovada sobrevive mesmo quando a data antiga já expiraria.
        await deleteInactiveSessions(db, new Date(now.getTime() + 2));
        expect(await db.session.findUnique({ where: { id: ids[0]! } })).toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[1]! } })).toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[2]! } })).toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[3]! } })).toBeNull();
        expect(await db.session.findUnique({ where: { id: ids[4]! } })).not.toBeNull();
        expect(await db.message.count({ where: { sessionId: { in: ids.slice(0, 4) } } })).toBe(0);
    } finally {
        try { await db.session.deleteMany({ where: { id: { in: ids } } }); }
        finally { await db.$disconnect(); }
    }
}, 20_000);
function app(db: PrismaClient) {
    return createSessionRoutes(db);
}

test.skipIf(!connectionString)("PostgreSQL Docker: POST /session persists messages and another client reloads them", async () => {
    const db = client();
    const reader = client();
    let id: string | undefined;
    try {
        const initialMessage = { role: "USER", content: "Mensagem de integração", mode: "PLAN", model: DEFAULT_CHAT_MODEL_ID };
        const response = await app(db).request("http://127.0.0.1:3000/", {
            method: "POST", headers, body: JSON.stringify({ title: "Integração Docker", initialMessage }),
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

test.skipIf(!connectionString)("PostgreSQL Docker: failed transaction does not leave a partial session", async () => {
    const db = client();
    const id = `integration-${randomUUID()}`;
    try {
        await expect(db.$transaction(async tx => {
            await tx.session.create({ data: { id, title: "Rollback", userId: "local-user", messages: {
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
