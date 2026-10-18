import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { openDatabase } from "@myagent/database";
import { removeTestDatabase } from "../../../database/src/test-cleanup";
import { withFixture } from "../test-support";
import { selectWorkspaceSession, listWorkspaceSessions } from "./workspace-sessions";
import { SessionLeases } from "./session-lease";
import { validateSessionWorkspace } from "../security/workspaces";
import { authorizeWorkspace } from "../security/workspaces";

test("workspace sessions resume latest, create new, isolate equal folder names and validate access", withFixture(async ({ root, cwd, outside }) => {
    const home = join(root, "database");
    let database = await openDatabase({ home });
    const left = join(cwd, "same"), right = join(outside, "same");
    await mkdir(left); await mkdir(right);
    try {
        const first = await selectWorkspaceSession(database.db, left);
        const second = await selectWorkspaceSession(database.db, left, true);
        await database.db.session.update({ where: { id: first.id }, data: { updatedAt: new Date(0) } });
        expect((await selectWorkspaceSession(database.db, left)).id).toBe(second.id);
        const other = await selectWorkspaceSession(database.db, right);
        expect(other.id).not.toBe(second.id);
        expect((await listWorkspaceSessions(database.db, left)).map(s => s.id)).toEqual([second.id, first.id]);
        expect((await listWorkspaceSessions(database.db)).length).toBe(3);
        await expect(validateSessionWorkspace(second, right, dir => authorizeWorkspace(dir, [left, right]))).rejects.toThrow("bloqueado");
        expect(await validateSessionWorkspace(second, left, dir => authorizeWorkspace(dir, [left]))).toBe(second.cwd!);
    } finally { await database.close(); database = undefined!; await removeTestDatabase(home); }
}), 20_000);

test("session lease rejects another owner, recovers orphaned leases and releases deterministically", withFixture(async ({ root, cwd }) => {
    const home = join(root, "database");
    let database = await openDatabase({ home });
    let reader = await openDatabase({ home });
    const first = new SessionLeases(database.db), second = new SessionLeases(reader.db);
    try {
        const session = await selectWorkspaceSession(database.db, cwd);
        await first.acquire(session.id, 1_000);
        await expect(second.acquire(session.id, 1_001)).rejects.toThrow("outro terminal");
        await second.acquire(session.id, 32_000);
        await expect(first.acquire(session.id, 32_001)).rejects.toThrow("outro terminal");
        await first.close();
        expect(await database.db.sessionLease.count()).toBe(1);
        await second.close();
        expect(await database.db.sessionLease.count()).toBe(0);
    } finally { await first.close(); await second.close(); await database.close(); await reader.close(); database = undefined!; reader = undefined!; await removeTestDatabase(home); }
}), 20_000);
