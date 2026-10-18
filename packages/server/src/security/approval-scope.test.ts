import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { affectedPaths, approvalScope } from "./approval-scope";
import { ApprovalManager, type ApprovalEvent } from "./permissions";
import { withFixture } from "../test-support";

test("session grants are exact per tool, path, workspace and session; once never grants future access", withFixture(async ({ cwd, outside }) => {
    const manager = new ApprovalManager();
    const scope = await approvalScope(cwd, "edit_file", { path: "a" });
    let events = 0;
    const allow = async (event: ApprovalEvent) => { events++; manager.decide("s", event.approvalId, true, true); };
    expect(await manager.request("s", "edit_file", { path: "a" }, allow, undefined, 100, scope)).toMatchObject({ choice: "session" });
    expect(await manager.request("s", "edit_file", { path: "./a" }, undefined, undefined, 100, await approvalScope(cwd, "edit_file", { path: "./a" }))).toMatchObject({ choice: "cached" });
    expect(events).toBe(1);
    for (const [session, tool, path, root] of [["other", "edit_file", "a", cwd], ["s", "write_file", "a", cwd], ["s", "edit_file", "b", cwd], ["s", "edit_file", "a", outside]] as const) {
        await expect(manager.request(session!, tool!, { path }, undefined, undefined, 100, await approvalScope(root!, tool!, { path })) ).rejects.toThrow("aprovação explícita");
    }
    const once = await approvalScope(cwd, "write_file", { path: "a" });
    await manager.request("s", "write_file", {}, async event => { manager.decide("s", event.approvalId, true); }, undefined, 100, once);
    await expect(manager.request("s", "write_file", {}, undefined, undefined, 100, once)).rejects.toThrow();
    manager.forget("s");
    await expect(manager.request("s", "edit_file", {}, undefined, undefined, 100, scope)).rejects.toThrow();
}));

test("web session scopes use origin, never subdomains, different protocols or ports", withFixture(async ({ cwd }) => {
    const first = await approvalScope(cwd, "web_fetch", { url: "https://example.com/docs?q=one" });
    expect(first.key).toBe((await approvalScope(cwd, "web_fetch", { url: "https://EXAMPLE.com/other?q=two" })).key);
    for (const url of ["https://sub.example.com", "http://example.com", "https://example.com:8443"]) {
        expect(first.key).not.toBe((await approvalScope(cwd, "web_fetch", { url })).key);
    }
    await expect(approvalScope(cwd, "web_fetch", { url: "https://user:pass@example.com" })).rejects.toThrow();
}));

test("commit and delete never remember permission even when the client asks; cancellation sends no approval", withFixture(async ({ cwd }) => {
    const manager = new ApprovalManager();
    for (const tool of ["git_commit", "delete_file"]) {
        const scope = await approvalScope(cwd, tool, { path: "a" });
        await manager.request("s", tool, {}, async event => {
            expect(event.allowSession).toBe(false);
            expect(manager.decide("s", event.approvalId, true, true)).toBe(false);
            expect(manager.decide("s", event.approvalId, true)).toBe(true);
        }, undefined, 100, scope);
        await expect(manager.request("s", tool, {}, undefined, undefined, 100, scope)).rejects.toThrow();
    }
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await expect(manager.request("s", "edit_file", {}, async () => { calls++; }, controller.signal)).rejects.toThrow();
    expect(calls).toBe(0);
}));

test("move scopes include both endpoints and patches include all safe files", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src"));
    const scope = await approvalScope(cwd, "move_file", { from: "a", to: "src/b" });
    expect(scope.key).not.toBe((await approvalScope(cwd, "move_file", { from: "a", to: "src/c" })).key);
    const patch = "--- a/src/a\n+++ b/src/a\n@@ -1 +1 @@\n-old\n+new\n";
    expect((await approvalScope(cwd, "apply_patch", { patch })).label).toContain("a");
    expect(await affectedPaths(cwd, "apply_patch", { patch: "diff --git a/mode-only b/mode-only\nold mode 100644\nnew mode 100755\n" + patch })).toHaveLength(2);
    await expect(approvalScope(cwd, "apply_patch", { patch: patch.replaceAll("src/a", "../outside") })).rejects.toThrow();
}));
