import type { PrismaClient } from "@myagent/database";
import { workspaceKey, workspaceTitle } from "../utils/workspace";

export async function selectWorkspaceSession(db: Pick<PrismaClient, "session">, workspace: string, createNew = false) {
    const key = await workspaceKey(workspace);
    if (!createNew) {
        const previous = await db.session.findFirst({ where: { workspacePath: key, userId: "local-user" }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
        if (previous) return previous;
    }
    return db.session.create({ data: { workspacePath: key, cwd: await workspaceTitle(workspace), title: await workspaceTitle(workspace), userId: "local-user", context: { create: {} } } });
}

export async function listWorkspaceSessions(db: Pick<PrismaClient, "session">, workspace?: string) {
    return db.session.findMany({ where: { userId: "local-user", ...(workspace && { workspacePath: await workspaceKey(workspace) }) }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
}
