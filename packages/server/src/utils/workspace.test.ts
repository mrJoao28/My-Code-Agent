import { expect, test } from "bun:test";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { withFixture } from "../test-support";
import { resolveWorkspaceRoot, workspaceKey, workspaceTitle } from "./workspace";
import { resolveSafePath } from "./path";
import { parse } from "node:path";

test("workspace resolves Git root, subfolders, spaces and folders without Git", withFixture(async ({ cwd, outside }) => {
    const nested = join(cwd, "pasta com espaços");
    await mkdir(nested);
    expect(await resolveWorkspaceRoot(outside)).toBe(await realpath(outside));
    execFileSync("git", ["init", cwd], { windowsHide: true, stdio: "ignore" });
    expect(await resolveWorkspaceRoot(nested)).toBe(await realpath(cwd));
    expect(await workspaceTitle(nested)).toBe(await realpath(nested));
    const canonical = await realpath(nested);
    expect(await resolveSafePath(parse(cwd).root, nested)).toBe(nested);
    expect(await workspaceKey(nested)).toBe(process.platform === "win32" ? canonical.toLowerCase() : canonical);
    if (process.platform === "win32") expect(await workspaceKey(nested.toUpperCase())).toBe(canonical.toLowerCase());
}), 20_000);

test("workspace rejects links, missing ancestors and paths through linked parents", withFixture(async ({ cwd, outside }) => {
    const linked = join(cwd, "alias");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(workspaceKey(linked)).rejects.toThrow("bloqueado");
    await expect(resolveWorkspaceRoot(join(linked, "missing", "child"))).rejects.toThrow();
    await expect(workspaceTitle(join(cwd, "missing", "child"))).rejects.toThrow();
}));
