import { describe, test, expect } from "bun:test";
import { writeFile, readFile, mkdir, symlink, link, access } from "node:fs/promises";
import { join } from "node:path";
import { createWriteFileTool } from "./write-file";
import { createReadFileTool } from "./read-file";
import { createEditFileTool } from "./edit-file";
import { createMoveFileTool } from "./move-file";
import { createDeleteFileTool } from "./delete-file";
import { createGrepTool } from "./grep";
import { createGlobTool, globToRegExp } from "./glob";
import { createListDirectoryTool } from "./list-directory";
import { createTodoWriteTool, getSessionTodos, clearSessionTodos } from "./todo-write";
import { execute, withFixture } from "../test-support";

describe("Existing file tools", () => {
    test("write creates directories; read supports lines; edit replaces once", withFixture(async ({ cwd }) => {
        const result = await execute(createWriteFileTool(cwd), { path: "src/a.ts", content: "first\nsecond\nthird" });
        expect(result.bytesWritten).toBe(18);
        expect((await execute(createReadFileTool(cwd), { path: "src/a.ts", offset: 1, limit: 1 })).content).toBe("2: second");
        await execute(createEditFileTool(cwd), { path: "src/a.ts", old_str: "second", new_str: "changed" });
        expect(await readFile(join(cwd, "src/a.ts"), "utf8")).toContain("changed");
        await expect(execute(createEditFileTool(cwd), { path: "src/a.ts", old_str: "missing", new_str: "x" })).rejects.toThrow();
    }));
    test("concurrent overwrite=false writes never overwrite each other", withFixture(async ({ cwd }) => {
        const tool = createWriteFileTool(cwd);
        const results = await Promise.allSettled([
            execute(tool, { path: "new.txt", content: "first", overwrite: false }),
            execute(tool, { path: "new.txt", content: "second", overwrite: false }),
        ]);
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        const content = await readFile(join(cwd, "new.txt"), "utf8");
        expect(["first", "second"]).toContain(content);
    }));
    test("ambiguous edits do not change the file", withFixture(async ({ cwd }) => {
        await writeFile(join(cwd, "a"), "same same");
        await expect(execute(createEditFileTool(cwd), { path: "a", old_str: "same", new_str: "x" })).rejects.toThrow();
        expect(await readFile(join(cwd, "a"), "utf8")).toBe("same same");
    }));
    test("overwrite protection and backup", withFixture(async ({ cwd }) => {
        await writeFile(join(cwd, "a"), "original");
        await expect(execute(createWriteFileTool(cwd), { path: "a", content: "new", overwrite: false })).rejects.toThrow();
        await execute(createWriteFileTool(cwd), { path: "a", content: "new", backup: true });
        expect(await readFile(join(cwd, "a.bak"), "utf8")).toBe("original");
    }));
    test("read truncates output and rejects directories and oversized files", withFixture(async ({ cwd }) => {
        await writeFile(join(cwd, "big"), "a".repeat(9_000) + "\n" + "b".repeat(2_000));
        expect((await execute(createReadFileTool(cwd), { path: "big" })).truncated).toBe(true);
        await expect(execute(createReadFileTool(cwd), { path: "." })).rejects.toThrow();
        await expect(execute(createWriteFileTool(cwd), { path: ".", content: "bad" })).rejects.toThrow("arquivo regular");
        await writeFile(join(cwd, "large"), Buffer.alloc(5 * 1024 * 1024 + 1));
        await expect(execute(createReadFileTool(cwd), { path: "large" })).rejects.toThrow();
    }));
    test("move then delete and root protection", withFixture(async ({ cwd }) => {
        await writeFile(join(cwd, "a"), "original");
        await execute(createMoveFileTool(cwd), { from: "a", to: "new/b" });
        expect(await readFile(join(cwd, "new/b"), "utf8")).toBe("original");
        await execute(createDeleteFileTool(cwd), { path: "new", recursive: true });
        await expect(access(join(cwd, "new"))).rejects.toThrow();
        await expect(execute(createDeleteFileTool(cwd), { path: ".", recursive: true })).rejects.toThrow();
        await expect(execute(createMoveFileTool(cwd), { from: ".", to: "nested" })).rejects.toThrow();
    }));
    test("move refuses existing destination", withFixture(async ({ cwd }) => {
        await writeFile(join(cwd, "a"), "a"); await writeFile(join(cwd, "b"), "b");
        await expect(execute(createMoveFileTool(cwd), { from: "a", to: "b" })).rejects.toThrow();
        expect(await readFile(join(cwd, "b"), "utf8")).toBe("b");
    }));
    test("recursive move/delete cannot touch hidden secrets", withFixture(async ({ cwd }) => {
        await mkdir(join(cwd, "dir")); await writeFile(join(cwd, "dir/.env"), "fixture-secret");
        await expect(execute(createDeleteFileTool(cwd), { path: "dir", recursive: true })).rejects.toThrow();
        await expect(execute(createMoveFileTool(cwd), { from: "dir", to: "elsewhere" })).rejects.toThrow();
        expect(await readFile(join(cwd, "dir/.env"), "utf8")).toBe("fixture-secret");
    }));
    test("search, glob and directory listings exclude secrets, links and dependency trees", withFixture(async ({ cwd, outside }) => {
        await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src/a.ts"), "needle\nNEEDLE");
        await writeFile(join(cwd, ".env"), "needle-secret");
        await mkdir(join(cwd, ".aws")); await writeFile(join(cwd, ".aws/config"), "needle-secret");
        await mkdir(join(cwd, "node_modules")); await writeFile(join(cwd, "node_modules/dep.ts"), "needle");
        await writeFile(join(outside, "private"), "needle-secret"); await link(join(outside, "private"), join(cwd, "alias"));
        await symlink(outside, join(cwd, "external"), process.platform === "win32" ? "junction" : "dir");
        const grep = await execute(createGrepTool(cwd), { pattern: "needle" });
        expect(grep.matches.map(m => m.file)).toEqual(["src/a.ts", "src/a.ts"]);
        expect((await execute(createGrepTool(cwd), { pattern: "needle", caseSensitive: true })).matches).toHaveLength(1);
        expect((await execute(createGlobTool(cwd), { pattern: "**/*.ts" })).matches).toEqual(["src/a.ts"]);
        const listing = await execute(createListDirectoryTool(cwd), {});
        expect(listing.entries.map(e => e.name)).not.toContain(".env");
        expect(listing.entries.map(e => e.name)).not.toContain("external");
        await expect(execute(createReadFileTool(cwd), { path: ".env" })).rejects.toThrow();
        await expect(execute(createGrepTool(cwd), { pattern: "needle", path: ".aws" })).rejects.toThrow();
        await expect(execute(createWriteFileTool(cwd), { path: "external/new/deep/file", content: "bad" })).rejects.toThrow();
    }));
    test("glob handles zero/multiple levels and literal metacharacters", () => {
        expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
        expect(globToRegExp("src/**/*.ts").test("src/deep/a.ts")).toBe(true);
        expect(globToRegExp("**/a.ts").test("not-a.ts")).toBe(false);
        expect(globToRegExp("file[1].ts").test("file[1].ts")).toBe(true);
        expect(globToRegExp("file[1].ts").test("file1.ts")).toBe(false);
    });
    test("todos are isolated by session and can be cleared", async () => {
        const id = crypto.randomUUID(), other = crypto.randomUUID();
        try {
            const result = await execute(createTodoWriteTool(id), { todos: [{ content: "work", status: "in_progress" }] });
            expect(result.inProgress).toBe(1);
            expect(getSessionTodos(id)).toHaveLength(1);
            expect(getSessionTodos(other)).toEqual([]);
            clearSessionTodos(id); expect(getSessionTodos(id)).toEqual([]);
        } finally { clearSessionTodos(id); clearSessionTodos(other); }
    });
});
