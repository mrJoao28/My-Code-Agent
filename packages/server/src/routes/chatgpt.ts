import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { chatGPT } from "../lib/chatgpt";
import type { ChatGPTService } from "../lib/chatgpt";

export function createChatGPTRoutes(service: ChatGPTService = chatGPT) {
    return new Hono()
        .onError((_error, c) => c.json({ error: "Não foi possível atualizar a conexão ChatGPT. Tente novamente ou conecte a conta outra vez." }, 400))
        .get("/", c => c.json(service.status()))
        .use("*", async (c, next) => {
            if (!service.enabled() && c.req.method !== "DELETE") return c.json({ error: "Login ChatGPT desativado. Defina MYAGENT_ENABLE_CHATGPT=1 para habilitar." }, 403);
            await next();
        })
        .post("/login", zValidator("json", z.object({ accountId: z.string().max(200).optional() })), async c => {
            const login = await service.startLogin(c.req.valid("json").accountId);
            if (c.req.raw.signal.aborted) { service.cancelLogin(login.id); return c.json({ error: "Login cancelado." }, 400); }
            return c.json(login);
        })
        .get("/login/:id", c => c.json(service.loginStatus(c.req.param("id"))))
        .delete("/login/:id", c => { service.cancelLogin(c.req.param("id")); return c.json({ ok: true }); })
        .post("/models", async c => {
            try { return c.json({ models: await service.refreshModels(c.req.raw.signal) }); }
            catch { return c.json({ error: "Não foi possível consultar os modelos. Confira o acesso da conta ao plano ChatGPT e tente novamente." }, 400); }
        })
        .post("/accounts/:id/activate", async c => { await service.activate(c.req.param("id")); return c.json({ ok: true }); })
        .delete("/accounts/:id", async c => c.json(await service.logout(c.req.param("id"))));
}
