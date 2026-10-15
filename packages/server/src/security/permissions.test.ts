import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { tool } from "ai";
import { z } from "zod";
import { ApprovalManager, PermissionDeniedError, toolDecision, type ApprovalEvent } from "./permissions";
import { secureTools } from "./tool-policy";
import { createPermissionRoutes } from "../routes/permissions";
import { localAuthentication } from "./auth";
import { createTools } from "../tools";
import { execute, withFixture } from "../test-support";

describe("Tool permissions", () => {
    test("classifies known tools and denies unknown tools by default", () => {
        expect(toolDecision("read_file", "PLAN")).toBe("allow");
        expect(toolDecision("bash", "PLAN")).toBe("deny");
        expect(toolDecision("bash", "BUILD")).toBe("approve");
        expect(toolDecision("web_fetch", "PLAN")).toBe("approve");
        expect(toolDecision("unknown", "BUILD")).toBe("deny");
    });
    test("PLAN exposes no mutation tool", withFixture(async ({ cwd }) => {
        const tools = createTools(cwd, "PLAN", "s");
        for (const name of ["write_file", "edit_file", "delete_file", "move_file", "apply_patch", "bash", "git_commit"]) expect(name in tools).toBe(false);
        expect("read_file" in tools).toBe(true);
        expect("write_file" in createTools(cwd, "BUILD", "s")).toBe(true);
    }));
    test("request waits, is session-bound and cannot be replayed", async () => {
        const manager = new ApprovalManager();
        let event!: ApprovalEvent, completed = false;
        const pending = manager.request("session", "write_file", { path: "a" }, async value => { event = value; }).then(() => { completed = true; });
        expect(completed).toBe(false);
        expect(manager.decide("other", event.approvalId, true)).toBe(false);
        expect(manager.decide("session", event.approvalId, true)).toBe(true);
        await pending; expect(completed).toBe(true);
        expect(manager.decide("session", event.approvalId, true)).toBe(false);
    });
    test("denial, timeout, abort and notify failures all fail closed", async () => {
        for (const scenario of ["deny", "timeout", "abort", "notify"]) {
            const manager = new ApprovalManager(), controller = new AbortController();
            let event!: ApprovalEvent;
            const pending = manager.request("s", "bash", {}, async value => {
                event = value; if (scenario === "notify") throw new Error("disconnected");
            }, controller.signal, 10);
            const rejected = expect(pending).rejects.toBeInstanceOf(PermissionDeniedError);
            if (scenario === "deny") manager.decide("s", event.approvalId, false);
            if (scenario === "abort") controller.abort();
            await rejected;
            expect(manager.decide("s", event.approvalId, true)).toBe(false);
        }
    });
    test("already aborted request sends no event", async () => {
        const manager = new ApprovalManager(), controller = new AbortController();
        controller.abort(); let notified = false;
        await expect(manager.request("s", "bash", {}, async () => { notified = true; }, controller.signal)).rejects.toThrow();
        expect(notified).toBe(false);
    });
    test("actual execute is blocked until approval and checks budget before effects", withFixture(async ({ cwd }) => {
        let calls = 0; const manager = new ApprovalManager(); let event!: ApprovalEvent;
        const original = { write_file: tool({ inputSchema: z.object({ path: z.string() }), execute: async () => { calls++; return "written"; } }) };
        const guarded = secureTools(original, cwd, "BUILD", "s", { manager, authorize: async () => cwd, notify: async value => { event = value; } });
        const running = execute(guarded.write_file, { path: "a" });
        while (!event) await Bun.sleep(1);
        expect(calls).toBe(0); manager.decide("s", event.approvalId, true);
        expect(await running).toBe("written"); expect(calls).toBe(1);
        const overBudget = secureTools(original, cwd, "BUILD", "s", { authorize: async () => cwd, beforeExecute: () => { throw new Error("budget exceeded"); } });
        await expect(execute(overBudget.write_file, { path: "a" })).rejects.toThrow("budget exceeded");
        expect(calls).toBe(1);
    }));
    test("missing approval channel, denied mode and revoked workspace prevent effects", withFixture(async ({ cwd }) => {
        let calls = 0;
        const original = { write_file: tool({ inputSchema: z.object({}), execute: async () => { calls++; return true; } }) };
        for (const mode of ["PLAN", "BUILD"] as const) {
            const guarded = secureTools(original, cwd, mode, "s", { authorize: async () => cwd });
            await expect(execute(guarded.write_file, {})).rejects.toThrow();
        }
        const guarded = secureTools(original, cwd, "BUILD", "s", { authorize: async () => { throw new Error("revoked"); } });
        await expect(execute(guarded.write_file, {})).rejects.toThrow("revoked");
        expect(calls).toBe(0);
    }));
    test("approval endpoint requires auth, validates decision and scopes session", async () => {
        const manager = new ApprovalManager(), token = "x".repeat(40); let event!: ApprovalEvent;
        const pending = manager.request("s", "bash", {}, async value => { event = value; });
        const app = new Hono().use("*", localAuthentication(token)).route("/permissions", createPermissionRoutes(manager));
        const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
        const path = "/permissions/s/" + event.approvalId;
        expect((await app.request(path, { method: "POST", body: '{"approved":true}' })).status).toBe(401);
        expect((await app.request(path, { method: "POST", headers, body: '{"approved":"true"}' })).status).toBe(400);
        expect((await app.request("/permissions/other/" + event.approvalId, { method: "POST", headers, body: '{"approved":true}' })).status).toBe(404);
        expect((await app.request(path, { method: "POST", headers, body: '{"approved":true}' })).status).toBe(200);
        await pending;
        expect((await app.request(path, { method: "POST", headers, body: '{"approved":true}' })).status).toBe(404);
    });
});
