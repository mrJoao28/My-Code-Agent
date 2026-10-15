import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { PrismaClient } from "@myagent/database";
import { Mode } from "@myagent/database/enums";
import { isSupportedChatModel } from "../lib/models";
import { authorizeWorkspace } from "../security/workspaces";
const createSessionSchema = z.object({
    title: z.string().trim().min(1).max(200), cwd: z.string().min(1).optional(),
    initialMessage: z.object({ role: z.literal("USER"), content: z.string().trim().min(1).max(100_000),
        mode: z.enum(Mode), model: z.string().refine(isSupportedChatModel, "Unsupported model"),
    }).optional(),
});
export function createSessionRoutes(db: Pick<PrismaClient, "session">, authorize = authorizeWorkspace) {
    return new Hono()
        .get("/", async c => c.json(await db.session.findMany({ orderBy: { updatedAt: "desc" }, select: { id: true, title: true, createdAt: true } })))
        .get("/:id", async c => {
            const session = await db.session.findUnique({ where: { id: c.req.param("id") }, include: { messages: { orderBy: { createdAt: "asc" } } } });
            return session ? c.json(session) : c.json({ error: "Session not found" }, 404);
        })
        .post("/", zValidator("json", createSessionSchema), async c => {
            const { initialMessage, ...data } = c.req.valid("json");
            const cwd = data.cwd ? await authorize(data.cwd) : null;
            const session = await db.session.create({
                data: { title: data.title, cwd, userId: "local-user",
                    ...(initialMessage && { messages: { create: { ...initialMessage, status: "COMPLETE" } } }),
                }, include: { messages: true },
            });
            return c.json(session, 201);
        });
}
