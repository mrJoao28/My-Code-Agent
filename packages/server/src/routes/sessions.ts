import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { PrismaClient } from "@myagent/database";
import { Mode } from "@myagent/database/enums";
import { isSupportedChatModel } from "../lib/models";
import { authorizeWorkspace } from "../security/workspaces";
import { loadSessionForUse, unexpiredSessionFilter } from "../services/session-lifecycle";
import { fitContextWindow } from "../services/session-context";
const createSessionSchema = z.object({
    title: z.string().trim().min(1).max(200), cwd: z.string().min(1).optional(),
    initialMessage: z.object({ role: z.literal("USER"), content: z.string().trim().min(1).max(100_000),
        mode: z.enum(Mode), model: z.string().refine(isSupportedChatModel, "Unsupported model"),
    }).optional(),
});
export function createSessionRoutes(db: Pick<PrismaClient, "session">, authorize = authorizeWorkspace) {
    return new Hono()
        .get("/", async c => c.json(await db.session.findMany({ where: unexpiredSessionFilter(), orderBy: { updatedAt: "desc" }, select: { id: true, title: true, createdAt: true } })))
        .get("/:id", async c => {
            const session = await loadSessionForUse(db, c.req.param("id"));
            return session ? c.json(session) : c.json({ error: "Session not found" }, 404);
        })
        .post("/", zValidator("json", createSessionSchema), async c => {
            const { initialMessage, ...data } = c.req.valid("json");
            if (initialMessage) {
                try { fitContextWindow([{ role: "user", content: initialMessage.content }]); }
                catch { return c.json({ error: "CONTEXT_MESSAGE_TOO_LARGE: divida a mensagem em partes menores" }, 413); }
            }
            const cwd = data.cwd ? await authorize(data.cwd) : null;
            const session = await db.session.create({
                data: { title: data.title, cwd, userId: "local-user",
                    context: { create: {} },
                    ...(initialMessage && { messages: { create: { ...initialMessage, status: "COMPLETE" } } }),
                }, include: { messages: true },
            });
            return c.json(session, 201);
        });
}
