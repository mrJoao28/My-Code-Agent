import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { approvals, type ApprovalManager } from "../security/permissions";

export function createPermissionRoutes(manager: ApprovalManager = approvals) {
    return new Hono().post("/:sessionId/:approvalId", zValidator("json", z.object({ approved: z.boolean() })), (c) => {
        const found = manager.decide(c.req.param("sessionId"), c.req.param("approvalId"), c.req.valid("json").approved);
        return found ? c.json({ accepted: true }) : c.json({ error: "Approval not found or expired" }, 404);
    });
}
