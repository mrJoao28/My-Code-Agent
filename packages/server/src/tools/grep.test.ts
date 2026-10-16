import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, withFixture } from "../test-support";
import { createGrepTool } from "./grep";

test("grep supports literal matches and reports invalid patterns", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "a.txt"), "a+b\naab\n");
    const result = await execute(createGrepTool(cwd), { pattern: "a+b", literal: true });
    expect(result.matches).toEqual([{ file: "a.txt", line: 1, text: "a+b" }]);
    await expect(execute(createGrepTool(cwd), { pattern: "[" })).rejects.toThrow("INVALID_PATTERN");
}));

test("pathological regex is terminated by a deadline without blocking the server", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "a.txt"), "a".repeat(30_000) + "!");
    await expect(execute(createGrepTool(cwd, 100), { pattern: "(a+)+$" })).rejects.toThrow("TOOL_TIMEOUT");
}));

test("already cancelled grep does not start its worker", withFixture(async ({ cwd }) => {
    const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
    await expect(execute(createGrepTool(cwd), { pattern: "a" }, controller.signal)).rejects.toThrow("fixture cancelled");
}));
