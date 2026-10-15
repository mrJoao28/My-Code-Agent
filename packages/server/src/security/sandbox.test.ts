import { test, expect } from "bun:test";
import { writeFile, readdir, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, dockerArguments, snapshotWorkspace, runSandboxCommand } from "./sandbox";
import { withFixture } from "../test-support";
test("snapshot omits secrets, links and host dependency executables", withFixture(async ({ cwd, outside, root }) => {
    await writeFile(join(cwd, "safe.ts"), "safe");
    await writeFile(join(cwd, ".env"), "fixture-secret");
    await writeFile(join(cwd, "api-token"), "fixture-secret");
    await mkdir(join(cwd, ".git")); await writeFile(join(cwd, ".git/config"), "private");
    await mkdir(join(cwd, "node_modules")); await writeFile(join(cwd, "node_modules/program"), "private");
    await symlink(outside, join(cwd, "external"), process.platform === "win32" ? "junction" : "dir");
    const snapshot = join(root, "snapshot");
    await snapshotWorkspace(cwd, snapshot);
    expect(await readdir(snapshot)).toEqual(["safe.ts"]);
    await expect(snapshotWorkspace(cwd, join(cwd, "snapshot"))).rejects.toThrow();
}));
test("docker config has isolation and never injects host secrets or an arbitrary option", () => {
    const args = dockerArguments("/snapshot", "myagent-test", "trusted-image", "echo test");
    expect(args).toContain("--network=none"); expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--read-only"); expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--pull=never"); expect(args).toContain("--user=65534:65534");
    expect(args.some(arg => arg.includes("source=/snapshot,target=/workspace,readonly"))).toBe(true);
    expect(args).not.toContain("--env"); expect(args.join(" ")).not.toContain("docker.sock");
    expect(() => dockerArguments("/snapshot", "test", "--privileged", "echo")).toThrow();
});
test("shell fails closed without configured sandbox", async () => {
    const previous = process.env.MYAGENT_SANDBOX_IMAGE; delete process.env.MYAGENT_SANDBOX_IMAGE;
    try { await expect(runSandboxCommand(".", "echo unsafe", 1000)).rejects.toThrow("Não há fallback"); }
    finally { if (previous === undefined) delete process.env.MYAGENT_SANDBOX_IMAGE; else process.env.MYAGENT_SANDBOX_IMAGE = previous; }
});
test("process output is bounded and reports exit status", async () => {
    const result = await runProcess(process.execPath, ["--eval", "console.log('x'.repeat(40000)); process.exit(7)"], { timeoutMs: 10_000 });
    expect(result.stdout.length).toBe(20_000); expect(result.truncated).toBe(true); expect(result.exitCode).toBe(7);
});
test("process timeout and cancellation stop execution and cleanup once", async () => {
    let stops = 0;
    const result = await runProcess(process.execPath, ["--eval", "setInterval(()=>{},1000)"], { timeoutMs: 100, onStop: async () => { stops++; } });
    expect(result.timedOut).toBe(true); expect(result.exitCode).toBe(124); expect(stops).toBe(1);
    const controller = new AbortController();
    const running = runProcess(process.execPath, ["--eval", "setInterval(()=>{},1000)"], { timeoutMs: 10_000, signal: controller.signal, onStop: async () => { stops++; } });
    controller.abort(); await running; expect(stops).toBe(2);
    await expect(runProcess(process.execPath, [], { timeoutMs: 100, signal: controller.signal })).rejects.toThrow();
});
test("legitimate commands can run for more than five seconds", async () => {
    const result = await runProcess(process.execPath, ["--eval", "setTimeout(()=>console.log('finished'),5500)"], { timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0); expect(result.stdout).toContain("finished"); expect(result.timedOut).toBe(false);
}, 15_000);
