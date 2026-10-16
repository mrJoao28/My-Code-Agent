import { expect, test } from "bun:test";
import { initializeDatabase, closeDatabase } from "@myagent/database";
import { startServer } from "./index";
import { selectWorkspaceSession } from "./services/workspace-sessions";
import { withFixture } from "./test-support";
import { join } from "node:path";
import { removeTestDatabase } from "../../database/src/test-cleanup";

test("embedded server binds a free loopback port, authenticates and releases session leases on shutdown", withFixture(async ({ root, cwd, outside }) => {
    const home = join(root, "database");
    let database = await initializeDatabase({ home });
    const token = "fixture-".repeat(8);
    const session = await selectWorkspaceSession(database.db, cwd);
    const running = await startServer({ port: 0, token, workspace: cwd, sessionId: session.id, dockerAvailable: false });
    try {
        expect(running.server.hostname).toBe("127.0.0.1");
        expect((await fetch(`${running.url}/session`)).status).toBe(401);
        expect((await fetch(`${running.url}/session/${session.id}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
        expect(await database.db.sessionLease.count()).toBe(1);
        const other = await selectWorkspaceSession(database.db, outside);
        const headers = { Authorization: `Bearer ${token}` };
        expect((await fetch(`${running.url}/session/${other.id}`, { headers })).status).toBe(403);
        expect((await fetch(`${running.url}/chat/${other.id}/resume`, { method: "POST", headers })).status).toBe(403);
        expect((await database.db.session.findUniqueOrThrow({ where: { id: other.id } })).updatedAt).toEqual(other.updatedAt);
        await running.stop();
        await running.stop();
        expect(await database.db.sessionLease.count()).toBe(0);
    } finally { await running.stop(); await closeDatabase(); database = undefined!; await removeTestDatabase(home); }
}), 20_000);
