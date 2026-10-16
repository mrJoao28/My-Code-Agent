import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, withFixture } from "../test-support";
import { createReadFileTool } from "./read-file";
import { createListDirectoryTool } from "./list-directory";
import { createGitStatusTool } from "./git-status";

test("file reads, listing and Git honor an already cancelled generation", withFixture(async ({ cwd }) => {
    const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
    await expect(execute(createReadFileTool(cwd), { path: "missing" }, controller.signal)).rejects.toThrow("fixture cancelled");
    await expect(execute(createListDirectoryTool(cwd), {}, controller.signal)).rejects.toThrow("fixture cancelled");
    await expect(execute(createGitStatusTool(cwd), {}, controller.signal)).rejects.toThrow("fixture cancelled");
}));

test("directory pages cover safe entries without exposing sensitive files", withFixture(async ({ cwd }) => {
    for (let i = 0; i < 5; i++) await writeFile(join(cwd, `${i}.txt`), "fixture");
    await writeFile(join(cwd, ".env"), "fixture-not-a-real-secret");
    const names: string[] = [];
    let offset: number | null = 0;
    do {
        const page: { entries: { name: string }[]; nextOffset: number | null } = await execute(createListDirectoryTool(cwd), { offset, limit: 2 });
        expect(page.entries.length).toBeLessThanOrEqual(2);
        names.push(...page.entries.map(e => e.name)); offset = page.nextOffset;
    } while (offset !== null);
    expect(names.sort()).toEqual(["0.txt", "1.txt", "2.txt", "3.txt", "4.txt"]);
}));
