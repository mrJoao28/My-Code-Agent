import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execute, withFixture } from "../test-support";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";

test("grep supports include globs, bounded context and files_only", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/a.ts"), "first\r\n  before\r\nneedle\r\n  after\r\nneedle");
    await writeFile(join(cwd, "src/b.txt"), "needle");
    const result = await execute(createGrepTool(cwd), { pattern: "needle", include: "*.ts", context: 1 });
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({ file: "src/a.ts", line: 3, text: "needle",
        before: [{ line: 2, text: "  before" }], after: [{ line: 4, text: "  after" }] });
    expect(result.matches[1]).toMatchObject({ before: [{ line: 4, text: "  after" }], after: [] });
    const files = await execute(createGrepTool(cwd), { pattern: "needle", include: "**/*.ts", files_only: true, context: 20 });
    expect(files.files).toEqual(["src/a.ts"]); expect(files.matches).toEqual([]);
    expect((await execute(createGrepTool(cwd), { pattern: "needle", path: "src", include: "*.txt", files_only: true })).files).toEqual(["src/b.txt"]);
}));

test("grep and glob honor root gitignore rules, negation and directory pruning from a subpath", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, ".gitignore"), ["# comment", "*.log", "/cache/", "generated/", "!generated/keep.ts",
        "*.tmp", "!keep.tmp", "src/private/*.ts", "!src/private/keep.ts", "\\#note.ts", "\\!note.ts",
        "[ab].log.ts", "literal{a,b}.ts", "!node_modules/allowed.ts", "!.env", ""].join("\r\n"));
    const paths = ["a.log", "cache/a.ts", "nested/cache/a.ts", "generated/keep.ts", "drop.tmp", "keep.tmp",
        "src/a.ts", "src/private/drop.ts", "src/private/keep.ts", "#note.ts", "!note.ts", "a.log.ts",
        "literal{a,b}.ts", "literala.ts", "node_modules/allowed.ts", ".env"];
    for (const path of paths) { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), "needle"); }
    const expected = ["keep.tmp", "literala.ts", "nested/cache/a.ts", "src/a.ts", "src/private/keep.ts"].sort();
    expect((await execute(createGrepTool(cwd), { pattern: "needle", files_only: true })).files?.sort()).toEqual(expected);
    expect((await execute(createGlobTool(cwd), { pattern: "**/*" })).matches.filter(p => p !== ".gitignore").sort()).toEqual(expected);
    expect((await execute(createGrepTool(cwd), { pattern: "needle", path: "src", include: "**/*.ts", files_only: true })).files?.sort()).toEqual(["src/a.ts", "src/private/keep.ts"]);
    expect((await execute(createGlobTool(cwd), { pattern: "**/*.ts", path: "src" })).matches.sort()).toEqual(["a.ts", "private/keep.ts"]);
    expect((await execute(createGrepTool(cwd), { pattern: "needle", path: "cache", files_only: true })).files).toEqual([]);
    expect((await execute(createGlobTool(cwd), { pattern: "**/*", path: "generated" })).matches).toEqual([]);
    expect((await execute(createGrepTool(cwd), { pattern: "needle", path: "node_modules", files_only: true })).files).toEqual([]);
    expect((await execute(createGlobTool(cwd), { pattern: "**/*", path: "node_modules" })).matches).toEqual([]);
}));

test("gitignore directory-only rules do not hide files and excluded parents cannot be bypassed", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, ".gitignore"), "logs/\nblocked/\n!blocked/keep.ts\n# comment\nfile with space.ts   \n");
    await writeFile(join(cwd, "logs"), "needle");
    await writeFile(join(cwd, "file with space.ts"), "needle");
    await mkdir(join(cwd, "nested/logs"), { recursive: true }); await writeFile(join(cwd, "nested/logs/a.ts"), "needle");
    await mkdir(join(cwd, "blocked")); await writeFile(join(cwd, "blocked/keep.ts"), "needle");
    expect((await execute(createGrepTool(cwd), { pattern: "needle", files_only: true })).files).toEqual(["logs"]);
    expect((await execute(createGlobTool(cwd), { pattern: "**/*", path: "blocked" })).matches).toEqual([]);
}));

test("searches refuse linked gitignore files", withFixture(async ({ cwd, outside }) => {
    await writeFile(join(outside, "rules"), "*.ts");
    await symlink(outside, join(cwd, ".gitignore"), process.platform === "win32" ? "junction" : "dir");
    await expect(execute(createGrepTool(cwd), { pattern: "a" })).rejects.toThrow("bloqueado");
    await expect(execute(createGlobTool(cwd), { pattern: "**/*" })).rejects.toThrow("bloqueado");
}));

test("searches refuse hardlinked gitignore files", withFixture(async ({ cwd, outside }) => {
    await writeFile(join(outside, "rules"), "*.ts");
    await link(join(outside, "rules"), join(cwd, ".gitignore"));
    await expect(execute(createGrepTool(cwd), { pattern: "a" })).rejects.toThrow("bloqueado");
    await expect(execute(createGlobTool(cwd), { pattern: "**/*" })).rejects.toThrow("bloqueado");
}));

test("searches bound the root gitignore read", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, ".gitignore"), "#".repeat(65_537));
    await expect(execute(createGrepTool(cwd), { pattern: "a" })).rejects.toThrow("FILE_TOO_LARGE");
    await expect(execute(createGlobTool(cwd), { pattern: "**/*" })).rejects.toThrow("FILE_TOO_LARGE");
}));

test("gitignore double stars inside a segment cannot cross directories", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, ".gitignore"), "partial**/file.ts\n");
    for (const path of ["partial/deep/file.ts", "partialx/file.ts"]) {
        await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), "needle");
    }
    expect((await execute(createGrepTool(cwd), { pattern: "needle", files_only: true })).files).toEqual(["partial/deep/file.ts"]);
    expect((await execute(createGlobTool(cwd), { pattern: "**/*.ts" })).matches).toEqual(["partial/deep/file.ts"]);
}));

test("grep bounds expanded context output", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "a.ts"), Array.from({ length: 300 }, () => "needle " + "x".repeat(400)).join("\n"));
    const result = await execute(createGrepTool(cwd), { pattern: "needle", context: 20 });
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(61_000);
}));
