import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { PrismaClient } from "@myagent/database";
import { Mode } from "@myagent/database/enums";
import { isSupportedChatModel } from "../lib/models";
import { authorizeWorkspace, requestWorkspace, validateSessionWorkspace } from "../security/workspaces";
import { workspaceKey, workspaceTitle } from "../utils/workspace";
import type { SessionLeases } from "../services/session-lease";
import { loadSessionForUse, unexpiredSessionFilter } from "../services/session-lifecycle";
import { fitContextWindow } from "../services/session-context";
const createSessionSchema = z.object({
    title: z.string().trim().min(1).max(32768).optional(), cwd: z.string().min(1).optional(),
    initialMessage: z.object({ role: z.literal("USER"), content: z.string().trim().min(1).max(100_000),
        mode: z.enum(Mode), model: z.string().refine(isSupportedChatModel, "Unsupported model"),
    }).optional(),
});
export function createSessionRoutes(db: Pick<PrismaClient, "session">, authorize = authorizeWorkspace, leases?: SessionLeases) {
    return new Hono()
        .get("/", async c => {
            const workspace = await requestWorkspace(c.req.header("X-Myagent-Workspace"), authorize);
            return c.json(await db.session.findMany({ where: { ...unexpiredSessionFilter(), userId: "local-user", workspacePath: await workspaceKey(workspace) }, orderBy: { updatedAt: "desc" }, select: { id: true, title: true, createdAt: true } }));
        })
        .get("/:id", async c => {
            const candidate = await db.session.findUnique({ where: { id: c.req.param("id") } });
            if (!candidate) return c.json({ error: "Session not found" }, 404);
            await validateSessionWorkspace(candidate, c.req.header("X-Myagent-Workspace"), authorize);
            await leases?.acquire(candidate.id);
            const session = await loadSessionForUse(db, c.req.param("id"));
            return session ? c.json(session) : c.json({ error: "Session not found" }, 404);
        })
        .post("/", zValidator("json", createSessionSchema), async c => {
            const { initialMessage, ...data } = c.req.valid("json");
            if (initialMessage) {
                try { fitContextWindow([{ role: "user", content: initialMessage.content }]); }
                catch { return c.json({ error: "CONTEXT_MESSAGE_TOO_LARGE: divida a mensagem em partes menores" }, 413); }
            }
            const cwd = await requestWorkspace(data.cwd ?? c.req.header("X-Myagent-Workspace"), authorize);
            const workspacePath = await workspaceKey(cwd);
            const title = await workspaceTitle(cwd);
            const session = await db.session.create({
                data: { title, cwd, workspacePath, userId: "local-user",
                    context: { create: {} },
                    ...(initialMessage && { messages: { create: { ...initialMessage, status: "COMPLETE" } } }),
                }, include: { messages: true },
            });
            await leases?.acquire(session.id);
            return c.json(session, 201);
        });
}
