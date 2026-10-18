import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { approvals, type ApprovalManager } from "../security/permissions";

export function createPermissionRoutes(manager: ApprovalManager = approvals) {
    return new Hono().post("/:sessionId/:approvalId", zValidator("json", z.object({ approved: z.boolean(), remember: z.boolean().optional() }).refine(value => !value.remember || value.approved)), (c) => {
        const found = manager.decide(c.req.param("sessionId"), c.req.param("approvalId"), c.req.valid("json").approved, c.req.valid("json").remember);
        return found ? c.json({ accepted: true }) : c.json({ error: "Aprovação inexistente, expirada ou opção de sessão não permitida" }, 404);
    });
}
