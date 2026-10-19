import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { tool } from "ai";
import { ApprovalManager, automationApproves, toolDecision } from "../security/permissions";
import { secureTools } from "../security/tool-policy";
import { approvalScope } from "../security/approval-scope";
import { preventEffectReplay } from "../services/generation-journal";
import { execute, withFixture } from "../test-support";
import { commitIdentity, gitEnvironment, gitNetworkOptions, redactGitOutput, runGit } from "../utils/git";
import { createGitCommitTool } from "./git-commit";
import { createWriteFileTool } from "./write-file";
import { createTools } from "./index";
import { APPROVED_MAIN_PUSH, createGitInitTool, createGitPushTool, createGitRemoteAddTool, createGitSwitchTool, createGitSyncTool, prepareGitApproval, validateGitURL } from "./git-workflow";

async function fixtureGit(cwd: string, args: string[]) {
    const process = Bun.spawn(["git", ...args], { cwd, env: gitEnvironment(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code) throw new Error(stderr); return stdout;
}
async function identity(root: string, run: () => Promise<void>, content = '[user]\nname = Fixture Global\nemail = fixture-global@example.invalid\n[core]\nhooksPath = /nonexistent-fixture-hooks\n') {
    const path = join(root, "fixture-global.gitconfig"); await writeFile(path, content);
    const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = path;
    try { await run(); } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
}

test("empty workspace → requested files → init → branch → global identity commit → bare push → ff-only sync", withFixture(async ({ root, cwd, outside }) => {
    await identity(root, async () => {
        const remote = join(outside, "remote.git");
        await fixtureGit(outside, ["init", "--bare", "-b", "main", remote]);
        const url = pathToFileURL(remote).href;
        // file:// existe só nesta fixture, sem flag de runtime que libere o protocolo.
        const dependencies = { validateURL: (value: string) => { if (value !== url) throw new Error("fixture remote only"); return value; }, networkOptions: async () => ["-c", "protocol.file.allow=always"] };
        await execute(createWriteFileTool(cwd), { path: "index.ts", content: 'export const ready = true;\n', overwrite: false, backup: false });
        expect(await execute(createGitInitTool(cwd), {})).toMatchObject({ branch: "main" });
        await execute(createGitCommitTool(cwd), { message: "requested structure", files: ["index.ts"] });
        expect((await runGit(cwd, ["log", "-1", "--format=%an <%ae>"])).stdout.trim()).toBe("Fixture Global <fixture-global@example.invalid>");
        await expect(runGit(cwd, ["config", "--local", "--get", "user.name"])).rejects.toThrow();
        await execute(createGitSwitchTool(cwd), { branch: "feature/step-10", create: true });
        await writeFile(join(cwd, "index.ts"), 'export const ready = "done";\n');
        await execute(createGitCommitTool(cwd), { message: "finish branch", files: ["index.ts"] });
        await execute(createGitRemoteAddTool(cwd, dependencies), { remote: "origin", url });
        expect(await execute(createGitRemoteAddTool(cwd, dependencies), { remote: "origin", url })).toMatchObject({ added: false });
        const pushed = await execute(createGitPushTool(cwd, dependencies), { remote: "origin", branch: "feature/step-10" });
        expect(pushed).toMatchObject({ pushed: true, awaitingRelease: true, branch: "feature/step-10" });
        const feature = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
        expect((await fixtureGit(outside, ["--git-dir=" + remote, "rev-parse", "refs/heads/feature/step-10"])).trim()).toBe(feature);
        // Simula a liberação do PR pelo dono do bare, não pelo agente.
        await fixtureGit(outside, ["--git-dir=" + remote, "update-ref", "refs/heads/main", feature]);
        await execute(createGitSwitchTool(cwd), { branch: "main", create: false });
        await execute(createGitSyncTool(cwd, dependencies), { remote: "origin", branch: "main" });
        expect(await readFile(join(cwd, "index.ts"), "utf8")).toContain('"done"');
        await expect(execute(createGitPushTool(cwd, dependencies), { remote: "origin", branch: "main" })).rejects.toThrow("confirmação explícita");
        // Divergência: nunca cria merge nem deixa conflitos para resolução automática.
        await runGit(cwd, ["reset", "--soft", "HEAD~1"]); // apenas o repositório temporário da fixture
        await writeFile(join(cwd, "index.ts"), "export const ready = false;\n");
        await execute(createGitCommitTool(cwd), { message: "diverged", files: ["index.ts"] });
        const before = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout;
        await expect(execute(createGitSyncTool(cwd, dependencies), { remote: "origin", branch: "main" })).rejects.toThrow();
        expect((await runGit(cwd, ["rev-parse", "HEAD"])).stdout).toBe(before);
    });
}), 120_000);

test("Git rejects nested init, existing metadata, invalid branches, credentials, force options and missing identity", withFixture(async ({ root, cwd }) => {
    await execute(createGitInitTool(cwd), {});
    await expect(execute(createGitInitTool(cwd), {})).rejects.toThrow("repositório");
    const nested = join(cwd, "nested"); await mkdir(nested);
    await expect(execute(createGitInitTool(nested), {})).rejects.toThrow("repositório");
    for (const branch of ["--force", "bad..name", "bad name", "HEAD", "@{-1}", "a:refs/tags/v1"])
        await expect(execute(createGitSwitchTool(cwd), { branch, create: true })).rejects.toThrow("branch inválido");
    for (const url of ["https://user:secret@github.com/owner/repo", "file:///tmp/repo", "ssh://github.com/owner/repo", "https://github.com.attacker.test/o/r", "https://github.com/o/r?token=secret"])
        expect(() => validateGitURL(url)).toThrow();
    expect(validateGitURL("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
    const push = createGitPushTool(cwd);
    const schema = push.inputSchema as z.ZodType;
    for (const extra of [{ force: true }, { forceWithLease: true }, { delete: true }, { mirror: true }, { tags: true }])
        expect(schema.safeParse({ remote: "origin", branch: "feature/x", ...extra }).success).toBe(false);
    await identity(root, async () => {
        await expect(commitIdentity(cwd)).rejects.toThrow("git config --global user.name");
        await writeFile(join(cwd, "a"), "a");
        await expect(execute(createGitCommitTool(cwd), { message: "missing identity", files: ["a"] })).rejects.toThrow("Identidade Git");
        expect((await runGit(cwd, ["diff", "--cached", "--name-only"])).stdout).toBe("");
    }, "");
    await identity(root, async () => {
        const options = await gitNetworkOptions(cwd);
        expect(options).toContain("protocol.https.allow=always");
        expect(options).toContain("credential.helper=fixture-credential-helper");
        expect(options).toContain("http.followRedirects=false");
        expect(options).not.toContain("protocol.file.allow=always");
    }, "[credential]\nhelper =\nhelper = fixture-credential-helper\n");
    await runGit(cwd, ["remote", "add", "origin", "https://github.com/o/first"]);
    await expect(execute(createGitRemoteAddTool(cwd), { remote: "origin", url: "https://github.com/o/second" })).rejects.toThrow("outra URL");
    await runGit(cwd, ["config", "url.https://attacker.test/.insteadOf", "https://github.com/"]);
    await expect(gitNetworkOptions(cwd)).rejects.toThrow("Configuração de transporte");
}), 120_000);

test("Git approvals bind URL and branch; main requires an explicit user confirmation; automation cannot bypass push gate", withFixture(async ({ cwd }) => {
    const manager = new ApprovalManager();
    const forbidden = ["git_init", "git_remote_add", "git_push", "git_commit", "delete_file"];
    for (const name of forbidden) {
        const args = { remote: "origin", url: "https://github.com/o/r", branch: "feature/x" };
        await manager.request("s", name, args, async event => {
            expect(event.allowSession).toBe(false);
            expect(manager.decide("s", event.approvalId, true, true)).toBe(false);
            expect(manager.decide("s", event.approvalId, true)).toBe(true);
        }, undefined, 1000, await approvalScope(cwd, name, args));
    }
    for (const branch of ["main", "master"]) await manager.request("s", "git_push", { branch }, async event => {
        expect(event.confirmation).toBe(branch);
        expect(manager.decide("s", event.approvalId, true)).toBe(false);
        expect(manager.decide("s", event.approvalId, true, false, "feature/x")).toBe(false);
        expect(manager.decide("s", event.approvalId, true, false, branch)).toBe(true);
    });
    expect(automationApproves("all", "git_push")).toBe(false);
    expect(automationApproves("all", "git_push", true)).toBe(true);
    for (const allowPush of [false, true]) {
        manager.setAutomation("exec", "all", allowPush);
        const pending = manager.request("exec", "git_push", { branch: "feature/x" }, async event => { manager.decide("exec", event.approvalId, true); }).then(() => true, () => false);
        expect(await pending).toBe(allowPush);
        const main = manager.request("exec", "git_push", { branch: "main" }, async event => { manager.decide("exec", event.approvalId, true, false, "main"); }).then(() => true, () => false);
        expect(await main).toBe(false);
    }
    for (const name of ["git_init", "git_switch", "git_remote_add", "git_push", "git_sync"]) {
        expect(() => preventEffectReplay([{ type: "tool-call", id: "old", name, args: { branch: "feature/x" }, execution: "started" }], name, { branch: "feature/x" })).toThrow("RETOMADA");
        expect(toolDecision(name, "PLAN")).toBe("deny");
        expect(toolDecision(name, "BUILD")).toBe("approve");
        expect(createTools(cwd, "PLAN", "s", { sandboxAvailable: false })).not.toHaveProperty(name);
    }
    await runGit(cwd, ["init", "-b", "main"]);
    await runGit(cwd, ["remote", "add", "origin", "https://github.com/o/r"]);
    const args = await prepareGitApproval(cwd, "git_push", { remote: "origin", branch: "main" });
    expect(args.url).toBe("https://github.com/o/r");
    await expect(prepareGitApproval(cwd, "git_push", { ...args, url: "https://github.com/o/changed" })).rejects.toThrow("mudou");
    const secured = secureTools({ git_push: tool({ inputSchema: z.object({ remote: z.string(), branch: z.string(), url: z.string().optional() }), execute: async (_input, options) => ({ confirmed: (options.context as Record<symbol, unknown>)[APPROVED_MAIN_PUSH] }) }) }, cwd, "BUILD", "s", {
        manager, authorize: async () => cwd, notify: async event => { expect(event.args.url).toBe("https://github.com/o/r"); manager.decide("s", event.approvalId, true, false, "main"); },
    });
    expect(await execute(secured.git_push, { remote: "origin", branch: "main" })).toMatchObject({ confirmed: "main" });
    const redacted = redactGitOutput("https://user:fixture-password@github.com/o/r Authorization: Bearer fixture-token ghp_1234567890");
    expect(redacted).not.toContain("fixture-password"); expect(redacted).not.toContain("fixture-token"); expect(redacted).not.toContain("ghp_");
}), 120_000);
