import { test, expect } from "bun:test";
import { writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./git";
import { withFixture } from "../test-support";
test("repository core.worktree cannot redirect reads or writes outside the workspace", withFixture(async ({ cwd, outside }) => {
    await runGit(cwd, ["init"]);
    await writeFile(join(cwd, "safe.txt"), "inside\n");
    await writeFile(join(outside, "safe.txt"), "outside-fixture\n");
    await runGit(cwd, ["config", "core.worktree", outside]);
    await runGit(cwd, ["add", "--", "safe.txt"]);
    expect((await runGit(cwd, ["show", ":safe.txt"])).stdout).toBe("inside\n");
    expect(await readFile(join(outside, "safe.txt"), "utf8")).toBe("outside-fixture\n");
}), 20_000);
test("Git metadata cannot be a junction to an external repository", withFixture(async ({ cwd, outside }) => {
    await symlink(outside, join(cwd, ".git"), process.platform === "win32" ? "junction" : "dir");
    await expect(runGit(cwd, ["status"])).rejects.toThrow();
}));
test("Git alternate object directories are rejected", withFixture(async ({ cwd, outside }) => {
    await runGit(cwd, ["init"]);
    await writeFile(join(cwd, ".git/objects/info/alternates"), outside + "\n");
    await expect(runGit(cwd, ["status"])).rejects.toThrow();
}), 10_000);
