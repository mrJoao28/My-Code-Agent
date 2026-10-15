import { describe, test, expect } from "bun:test";
import { mkdir, writeFile, symlink, link } from "node:fs/promises";
import { join, win32 } from "node:path";
import { resolveSafePath, UnsafePathError, PathNotFoundError, isInside, isSensitivePath, assertSafeTree } from "./path";
import { authorizeWorkspace } from "../security/workspaces";
import { withFixture } from "../test-support";

describe("Workspace paths", () => {
    test("existing files, absent descendants and valid ..prefix names", withFixture(async ({ cwd }) => {
        await mkdir(join(cwd, "..valid")); await writeFile(join(cwd, "..valid", "a.ts"), "ok");
        expect(await resolveSafePath(cwd, "..valid/a.ts")).toBe(join(cwd, "..valid", "a.ts"));
        expect(await resolveSafePath(cwd, "new/deep/a.ts", { mustExist: false })).toBe(join(cwd, "new", "deep", "a.ts"));
        await expect(resolveSafePath(cwd, "missing")).rejects.toBeInstanceOf(PathNotFoundError);
    }));
    test("traversal and absolute paths outside root", withFixture(async ({ cwd, outside }) => {
        for (const path of ["../outside/a", outside, "../workspace-other"]) {
            await expect(resolveSafePath(cwd, path, { mustExist: false })).rejects.toBeInstanceOf(UnsafePathError);
        }
    }));
    test.each([".env", ".ENV.local", ".aws/config", ".ssh/id_ed25519", ".myagent/api-token", "custom-config/api-token", ".docker/config.json", ".git/config", "a/private.pem", ".npmrc", "credentials.json", "secret.backup", "file:stream", "NUL.txt", "file."])("rejects protected or ambiguous path %s", async path => {
        await withFixture(async ({ cwd }) => {
            await expect(resolveSafePath(cwd, path, { mustExist: false })).rejects.toBeInstanceOf(UnsafePathError);
        })();
    });
    test("template is readable and invalid roots fail closed", withFixture(async ({ cwd }) => {
        await writeFile(join(cwd, ".env.example"), "DUMMY=");
        expect(await resolveSafePath(cwd, ".env.example")).toBe(join(cwd, ".env.example"));
        await expect(resolveSafePath(join(cwd, "missing"), "a", { mustExist: false })).rejects.toThrow();
    }));
    test("junction with multiple absent descendants cannot escape", withFixture(async ({ cwd, outside }) => {
        await symlink(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
        await expect(resolveSafePath(cwd, "linked/new/deep/file", { mustExist: false })).rejects.toBeInstanceOf(UnsafePathError);
        await expect(authorizeWorkspace(join(cwd, "linked"), [cwd])).rejects.toBeInstanceOf(UnsafePathError);
    }));
    test("internal junction aliases are denied", withFixture(async ({ cwd }) => {
        await mkdir(join(cwd, "real"));
        await symlink(join(cwd, "real"), join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
        await expect(resolveSafePath(cwd, "alias/missing", { mustExist: false })).rejects.toBeInstanceOf(UnsafePathError);
    }));
    test("hard links cannot alias protected files", withFixture(async ({ cwd, outside }) => {
        await writeFile(join(outside, "private"), "fixture-secret");
        await link(join(outside, "private"), join(cwd, "innocent"));
        await expect(resolveSafePath(cwd, "innocent")).rejects.toBeInstanceOf(UnsafePathError);
    }));
    test("Windows drive, UNC and sibling boundaries", () => {
        expect(isInside("C:\\project", "D:\\private", win32)).toBe(false);
        expect(isInside("C:\\project", "C:\\project-other", win32)).toBe(false);
        expect(isInside("C:\\project", "C:\\project\\..valid", win32)).toBe(true);
        expect(isInside("\\\\server\\share\\project", "\\\\other\\share\\project", win32)).toBe(false);
    });
    test("workspace must be an authorized existing absolute directory", withFixture(async ({ cwd, outside }) => {
        await mkdir(join(cwd, "child"));
        expect(await authorizeWorkspace(join(cwd, "child"), [cwd])).toBe(await resolveSafePath(cwd, "child"));
        await expect(authorizeWorkspace(outside, [cwd])).rejects.toBeInstanceOf(UnsafePathError);
        await expect(authorizeWorkspace(".", [cwd])).rejects.toBeInstanceOf(UnsafePathError);
        await writeFile(join(cwd, "file"), "x");
        await expect(authorizeWorkspace(join(cwd, "file"), [cwd])).rejects.toBeInstanceOf(UnsafePathError);
    }));
    test("recursive actions reject sensitive descendants", withFixture(async ({ cwd }) => {
        await mkdir(join(cwd, "folder")); await writeFile(join(cwd, "folder", ".env"), "fixture-secret");
        await expect(assertSafeTree(cwd, "folder")).rejects.toBeInstanceOf(UnsafePathError);
    }));
    test("case-insensitive sensitive names", () => {
        expect(isSensitivePath("src/.AWS/credentials")).toBe(true);
        expect(isSensitivePath("src/server.ts")).toBe(false);
        expect(isSensitivePath(".gitignore")).toBe(false);
    });
});
