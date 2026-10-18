import { expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { runMigrations, migrations } from "./migrations";
import { openDatabase } from "./client";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestDatabase } from "./test-cleanup";

test("SQLite migrations initialize once and rollback the whole pending sequence", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
        const initial = [{ version: 1, sql: "CREATE TABLE fixture (id TEXT PRIMARY KEY);" }];
        await runMigrations(client, initial);
        await runMigrations(client, initial);
        expect(Number((await client.execute("PRAGMA user_version")).rows[0]?.user_version)).toBe(1);
        await expect(runMigrations(client, [
            { version: 1, sql: "" },
            { version: 2, sql: "CREATE TABLE rollback_fixture (id TEXT);" },
            { version: 3, sql: "INSERT INTO missing_fixture VALUES (1);" },
        ])).rejects.toThrow("alterações revertidas");
        expect(Number((await client.execute("PRAGMA user_version")).rows[0]?.user_version)).toBe(1);
        expect((await client.execute("SELECT name FROM sqlite_master WHERE name='rollback_fixture'")).rows).toHaveLength(0);
    } finally { client.close(); }
});

test("local database persists enums and Json and enables WAL, timeouts and cascades", async () => {
    const home = await mkdtemp(join(tmpdir(), "myagent-db-"));
    let database = await openDatabase({ home });
    try {
        expect((await database.client.execute("PRAGMA journal_mode")).rows[0]?.journal_mode).toBe("wal");
        expect(Number((await database.db.$queryRawUnsafe<any[]>("PRAGMA busy_timeout"))[0]?.timeout)).toBe(5000);
        expect(Number((await database.db.$queryRawUnsafe<any[]>("PRAGMA foreign_keys"))[0]?.foreign_keys)).toBe(1);
        const session = await database.db.session.create({ data: { userId: "local-user", title: home, workspacePath: home,
            messages: { create: { role: "USER", status: "COMPLETE", mode: "BUILD", model: "fixture", content: "teste", parts: [{ type: "text", text: "teste" }] } },
        }, include: { messages: true } });
        expect(session.messages[0]?.parts).toEqual([{ type: "text", text: "teste" }]);
        await database.db.session.delete({ where: { id: session.id } });
        expect(await database.db.message.count()).toBe(0);
    } finally {
        await database.close();
        database = undefined!;
        await removeTestDatabase(home);
    }
});

test("in-memory opening shares the migrated connection with Prisma", async () => {
    const database = await openDatabase({ url: "file::memory:" });
    try { expect(await database.db.session.count()).toBe(0); }
    finally { await database.close(); }
});


test("migration upgrades existing SQLite messages without rewriting history", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
        await runMigrations(client, migrations.slice(0, 2));
        await client.execute(`INSERT INTO Session (id, userId, title, updatedAt, workspacePath) VALUES ('old', 'local-user', 'old', 0, '/fixture')`);
        await client.execute(`INSERT INTO Message (id, sessionId, role, status, model, content, mode, parts) VALUES ('old-message', 'old', 'ASSISTANT', 'COMPLETE', 'fixture', 'preserved', 'BUILD', '[{"type":"text","text":"preserved"}]')`);
        await runMigrations(client);
        const row = (await client.execute("SELECT status, content, parts, generationId FROM Message WHERE id='old-message'")).rows[0]!;
        expect(row.status).toBe("COMPLETE"); expect(row.content).toBe("preserved"); expect(row.generationId).toBeNull();
        expect(JSON.parse(String(row.parts))).toEqual([{ type: "text", text: "preserved" }]);
        expect((await client.execute("SELECT retentionWarnedAt FROM Session")).rows[0]?.retentionWarnedAt).toBeNull();
        await client.execute("UPDATE Message SET status='IN_PROGRESS' WHERE id='old-message'");
        expect((await client.execute("SELECT status FROM Message")).rows[0]?.status).toBe("IN_PROGRESS");
    } finally { client.close(); }
});
