import { test, expect } from "bun:test";
import { writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { runGit, gitEnvironment } from "../utils/git";
import { createGitStatusTool } from "./git-status";
import { createGitDiffTool } from "./git-diff";
import { createGitLogTool } from "./git-log";
import { createGitCommitTool } from "./git-commit";
import { createApplyPatchTool } from "./apply-patch";
import { execute, withFixture } from "../test-support";

async function init(cwd: string) {
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.name", "Test"]);
    await runGit(cwd, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(cwd, "a.txt"), "original\n");
    await execute(createGitCommitTool(cwd), { message: "initial", files: ["a.txt"] });
}
test("Git status/diff/log and selective commits preserve unrelated staged changes", withFixture(async ({ cwd }) => {
    await init(cwd);
    await writeFile(join(cwd, "a.txt"), "changed\n"); await writeFile(join(cwd, "unrelated.txt"), "user changes\n");
    await runGit(cwd, ["add", "--", "unrelated.txt"]);
    expect((await execute(createGitStatusTool(cwd), {})).clean).toBe(false);
    expect((await execute(createGitDiffTool(cwd), {})).diff).toContain("+changed");
    const commit = await execute(createGitCommitTool(cwd), { message: "change only a", files: ["a.txt"] });
    expect(commit.files).toEqual(["a.txt"]);
    expect((await runGit(cwd, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("unrelated.txt");
    expect((await execute(createGitLogTool(cwd), { limit: 1, path: "a.txt" })).commits[0]?.message).toBe("change only a");
}), 30_000);
test("Git filters and hooks cannot execute code in the host", withFixture(async ({ cwd }) => {
    await init(cwd);
    await writeFile(join(cwd, "a.txt"), "changed\n");
    await writeFile(join(cwd, ".gitattributes"), "*.txt filter=malicious\n");
    await runGit(cwd, ["config", "filter.malicious.clean", "touch FILTER_RAN"]);
    await runGit(cwd, ["config", "filter.malicious.required", "true"]);
    await writeFile(join(cwd, ".git/hooks/pre-commit"), "#!/bin/sh\ntouch HOOK_RAN\n", { mode: 0o755 });
    await execute(createGitCommitTool(cwd), { message: "safe commit", files: ["a.txt"] });
    await expect(access(join(cwd, "FILTER_RAN"))).rejects.toThrow();
    await expect(access(join(cwd, "HOOK_RAN"))).rejects.toThrow();
}), 30_000);
test("Git diff refuses protected files and omits tracked secrets", withFixture(async ({ cwd }) => {
    await init(cwd);
    await writeFile(join(cwd, ".env"), "old-fixture-secret\n");
    // Test setup deliberately stages a secret using fixed host Git, never agent tools.
    await runGit(cwd, ["add", "--", ".env"]);
    await runGit(cwd, ["commit", "-m", "fixture"]);
    await writeFile(join(cwd, ".env"), "new-fixture-secret\n");
    await writeFile(join(cwd, "a.txt"), "safe change\n");
    const diff = await execute(createGitDiffTool(cwd), {});
    expect(diff.diff).toContain("safe change"); expect(diff.diff).not.toContain("fixture-secret");
    await expect(execute(createGitDiffTool(cwd), { path: ".env" })).rejects.toThrow();
    await expect(execute(createGitCommitTool(cwd), { message: "bad", files: [".env"] })).rejects.toThrow();
    expect(gitEnvironment()).not.toHaveProperty("DATABASE_URL");
}), 30_000);
test("apply_patch validates all targets before touching files and supports checkOnly", withFixture(async ({ cwd }) => {
    await init(cwd);
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-original\n+patched\n";
    expect((await execute(createApplyPatchTool(cwd), { patch, checkOnly: true })).valid).toBe(true);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("original\n");
    await execute(createApplyPatchTool(cwd), { patch });
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("patched\n");
    for (const path of [".env", "../outside/file", ".git/config"]) {
        const unsafe = "--- a/" + path + "\n+++ b/" + path + "\n@@ -1 +1 @@\n-old\n+new\n";
        await expect(execute(createApplyPatchTool(cwd), { patch: unsafe })).rejects.toThrow();
    }
    await expect(execute(createApplyPatchTool(cwd), { patch: "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/outside\n" })).rejects.toThrow();
}), 30_000);
