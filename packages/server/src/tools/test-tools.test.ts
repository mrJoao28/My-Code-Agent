import { expect, test, mock } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { execute, withFixture } from "../test-support";
import { createTestRunTool } from "./test-run";
import { createTools } from "./index";
import { toolDecision, ApprovalManager, type ApprovalEvent } from "../security/permissions";
import { secureTools } from "../security/tool-policy";
import type { CommandResult } from "../security/sandbox";

const successful: CommandResult = { stdout: "fixture tests passed", stderr: "", exitCode: 0, timedOut: false, truncated: false };
const names = ["read_files", "project_inspect", "file_outline", "environment_check", "symbol_search", "test_run", "test_discover", "git_show", "git_blame", "diff_summary"];
test.each(["PLAN", "BUILD"] as const)("new tools have schemas and explicit %s permissions", mode => {
    const tools = createTools("/fixture", mode, "fixture");
    for (const name of names) {
        expect(name in tools).toBe(true);
        expect(toolDecision(name, mode)).toBe(name === "test_run" ? "approve" : "allow");
    }
    const runnerSchema = tools.test_run.inputSchema as z.ZodType;
    expect(runnerSchema.safeParse({ runner: "sh" }).success).toBe(false);
    expect(runnerSchema.safeParse({ timeoutMs: 120_001 }).success).toBe(false);
    expect(runnerSchema.safeParse({ files: Array(11).fill("a.test.ts") }).success).toBe(false);
    expect((tools.symbol_search.inputSchema as z.ZodType).safeParse({ query: "" }).success).toBe(false);
    expect((tools.git_show.inputSchema as z.ZodType).safeParse({ revision: "--output=unsafe" }).success).toBe(false);
    expect((tools.read_files.inputSchema as z.ZodType).safeParse({ files: Array(9).fill({ path: "a" }) }).success).toBe(false);
});

test("test_run quotes paths and executes only the fixed sandbox runner on a disposable copy", withFixture(async ({ cwd }) => {
    const file = "test ' $(echo fixture).test.ts"; await writeFile(join(cwd, file), "");
    const run = mock(async (_cwd: string, _command: string, _timeout: number, _signal?: AbortSignal) => successful);
    const result = await execute(createTestRunTool(cwd, run), { runner: "bun", files: [file], timeoutMs: 2_000 });
    expect(result.status).toBe("passed"); expect(result.exitCode).toBe(0);
    const args = run.mock.calls[0]!;
    expect(args[0]).toBe(cwd); expect(args[2]).toBe(2_000);
    expect(args[1]).toContain('cp -R /workspace/. "$testdir/"');
    expect(args[1]).toContain("mktemp -d /tmp/myagent-tests.");
    expect(args[1]).toContain("'bun' 'test'"); expect(args[1]).toContain("'\\''");
    expect(args[1]).not.toMatch(/npm|npx|install/);
}));

test("test_run distinguishes command failure and timeout and propagates cancellation", withFixture(async ({ cwd }) => {
    for (const [exitCode, timedOut, status] of [[1, false, "failed"], [124, true, "timed_out"]] as const) {
        const result = await execute(createTestRunTool(cwd, async () => ({ ...successful, exitCode, timedOut, truncated: true })), {});
        expect(result.status).toBe(status); expect(result.truncated).toBe(true);
    }
    const controller = new AbortController();
    const run = mock(async (_cwd: string, _command: string, _timeout: number, signal?: AbortSignal) => { expect(signal).toBe(controller.signal); controller.abort(new Error("fixture cancelled")); return successful; });
    await expect(execute(createTestRunTool(cwd, run), {}, controller.signal)).rejects.toThrow("fixture cancelled");
    const notCalled = mock(async () => successful);
    await expect(execute(createTestRunTool(cwd, notCalled), {}, controller.signal)).rejects.toThrow("fixture cancelled");
    expect(notCalled).not.toHaveBeenCalled();
}));

test("test_run fails closed without a sandbox and rejects traversal before execution", withFixture(async ({ cwd }) => {
    const run = mock(async () => successful);
    await expect(execute(createTestRunTool(cwd, run), { path: "../outside" })).rejects.toThrow();
    await expect(execute(createTestRunTool(cwd, run), { files: [".env"] })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    const previous = process.env.MYAGENT_SANDBOX_IMAGE; delete process.env.MYAGENT_SANDBOX_IMAGE;
    try { await expect(execute(createTestRunTool(cwd), {})).rejects.toThrow("Não há fallback"); }
    finally { if (previous === undefined) delete process.env.MYAGENT_SANDBOX_IMAGE; else process.env.MYAGENT_SANDBOX_IMAGE = previous; }
}));

test("test_run in PLAN waits for approval and denial never invokes the sandbox", withFixture(async ({ cwd }) => {
    const manager = new ApprovalManager(), run = mock(async () => successful); let event: ApprovalEvent | undefined;
    const tools = secureTools({ test_run: createTestRunTool(cwd, run) }, cwd, "PLAN", "s", { manager, authorize: async () => cwd, notify: async value => { event = value; } });
    const pending = execute(tools.test_run, {});
    while (!event) await Bun.sleep(1);
    expect(run).not.toHaveBeenCalled(); manager.decide("s", event.approvalId, false);
    await expect(pending).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
    event = undefined;
    const approved = execute(tools.test_run, {});
    while (!event) await Bun.sleep(1);
    manager.decide("s", (event as ApprovalEvent).approvalId, true);
    expect((await approved).status).toBe("passed"); expect(run).toHaveBeenCalledTimes(1);
}));
