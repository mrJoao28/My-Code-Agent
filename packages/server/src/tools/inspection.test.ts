import { expect, test } from "bun:test";
import { mkdir, writeFile, link, access } from "node:fs/promises";
import { join } from "node:path";
import { execute, withFixture } from "../test-support";
import { createReadFilesTool } from "./read-files";
import { createProjectInspectTool } from "./project-inspect";
import { createFileOutlineTool } from "./file-outline";
import { createSymbolSearchTool } from "./symbol-search";
import { createEnvironmentCheckTool } from "./environment-check";
import { createTestDiscoverTool } from "./test-discover";
import { limitInspectionOutput } from "../lib/project-inspection";
import { withSourceAnalyzer } from "../lib/source-analysis";

test("active AST worker is cancelled without waiting for its parse result", async () => {
    const controller = new AbortController();
    const pending = withSourceAnalyzer(controller.signal, async analyze => {
        const work = analyze("fixture.ts", "const item = 1;");
        controller.abort(new Error("fixture worker cancelled"));
        return work;
    });
    await expect(pending).rejects.toThrow("fixture worker cancelled");
});

test("read_files selects lines, preserves partial success and blocks protected paths", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "a.txt"), "first\nsecond\nthird");
    const result = await execute(createReadFilesTool(cwd), { files: [{ path: "a.txt", offset: 1, limit: 1 }, { path: ".env" }, { path: "../outside/a.txt" }, { path: "missing" }] });
    expect(result.files[0]).toMatchObject({ content: "second", totalLines: 3, truncated: false });
    expect(result.files.slice(1).map(f => f.error)).toEqual(["PATH_BLOCKED", "PATH_BLOCKED", "NOT_FOUND"]);
}));

test("read_files bounds content and rejects binary, oversized files and hard links", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "large.txt"), "x".repeat(20_000));
    const result = await execute(createReadFilesTool(cwd), { files: Array.from({ length: 4 }, () => ({ path: "large.txt" })) });
    expect(result.files.reduce((n, f) => n + (f.content?.length ?? 0), 0)).toBe(30_000);
    expect(result.files[3]?.error).toBe("BATCH_LIMIT"); expect(result.truncated).toBe(true);
    await writeFile(join(cwd, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(cwd, "huge"), Buffer.alloc(1_048_577, 120));
    await link(join(cwd, "large.txt"), join(cwd, "alias.txt"));
    const errors = await execute(createReadFilesTool(cwd), { files: [{ path: "binary" }, { path: "huge" }, { path: "alias.txt" }] });
    expect(errors.files.map(f => f.error)).toEqual(["BINARY_FILE", "FILE_TOO_LARGE", "PATH_BLOCKED"]);
}));

test("project inspection and discovery read manifests but never execute project configuration", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src")); await mkdir(join(cwd, "node_modules")); await mkdir(join(cwd, "nested"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "touch SHOULD_NOT_RUN", "test:unit": "bun test", build: "build" }, devDependencies: { vitest: "1" } }));
    await writeFile(join(cwd, "nested/package.json"), "invalid fixture");
    await writeFile(join(cwd, "vitest.config.ts"), "throw new Error('must never execute')");
    await writeFile(join(cwd, "src/a.test.ts"), "test('example')");
    await writeFile(join(cwd, "src/test_unit.py"), "def test_unit(): pass");
    await writeFile(join(cwd, "src/a_test.go"), "package sample");
    await writeFile(join(cwd, "node_modules/hidden.test.ts"), "");
    await writeFile(join(cwd, ".env"), "FIXTURE_NOT_A_REAL_SECRET");
    const inspected = await execute(createProjectInspectTool(cwd), {});
    expect(inspected.packages[0]).toMatchObject({ path: "package.json", scripts: ["test", "test:unit", "build"], dependencies: ["vitest"] });
    expect(inspected.errors).toEqual([{ path: "nested/package.json", error: "INVALID_PACKAGE_JSON" }]);
    expect(inspected.configurationFiles).toContain("vitest.config.ts");
    expect(inspected.files).not.toContain(".env"); expect(JSON.stringify(inspected)).not.toContain("touch SHOULD_NOT_RUN");
    const discovered = await execute(createTestDiscoverTool(cwd), {});
    expect(discovered.tests).toEqual(["src/a.test.ts", "src/a_test.go", "src/test_unit.py"]);
    expect(discovered.packages[0]?.scripts).toEqual(["test", "test:unit"]);
    expect(discovered.packages[0]?.runners).toEqual(["vitest"]);
    await expect(access(join(cwd, "SHOULD_NOT_RUN"))).rejects.toThrow();
}));

test("AST outline and symbol search find declarations rather than comments, strings or references", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "source.ts"), 'export function greeting() { return "function imaginary() {}"; }\nexport const greetValue = 1;\nclass WorkerClass { greetMethod() {} }\n// function commentOnly() {}\ngreeting();');
    const outline = await execute(createFileOutlineTool(cwd), { path: "source.ts" });
    expect(outline.symbols.map(s => s.name)).toEqual(["greeting", "greetValue", "WorkerClass", "greetMethod"]);
    expect(outline.symbols[0]).toMatchObject({ line: 1, endLine: 1, exported: true });
    expect(outline.symbols[1]?.exported).toBe(true);
    const found = await execute(createSymbolSearchTool(cwd), { query: "GREET", path: "source.ts" });
    expect(found.matches.map(m => m.name)).toEqual(["greeting", "greetValue", "greetMethod"]);
    expect(found.matches.every(m => m.path === "source.ts")).toBe(true);
    expect((await execute(createSymbolSearchTool(cwd), { query: "GREET", caseSensitive: true })).matches).toEqual([]);
    await expect(execute(createFileOutlineTool(cwd), { path: "source.py" })).rejects.toThrow("UNSUPPORTED_LANGUAGE");
}), 90_000);

test("manifest and category limits propagate incomplete inspection and discovery", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`test:unit${i}`, "fixture"])) }));
    const project = await execute(createProjectInspectTool(cwd), {});
    expect(project.packages[0]?.scripts).toHaveLength(100);
    expect(project.packages[0]?.truncated).toBe(true); expect(project.truncated).toBe(true);
    expect((await execute(createTestDiscoverTool(cwd), {})).truncated).toBe(true);
    await writeFile(join(cwd, "package.json"), "{}");
    for (let i = 0; i < 55; i++) await writeFile(join(cwd, `${i}.test.ts`), "");
    const limited = await execute(createProjectInspectTool(cwd), {});
    expect(limited.testFiles).toHaveLength(50); expect(limited.truncated).toBe(true);
}));

test("symbol limits and structured output explicitly report incomplete results", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "many.ts"), Array.from({ length: 220 }, (_, i) => `const item${i} = ${i};`).join("\n"));
    const outline = await execute(createFileOutlineTool(cwd), { path: "many.ts" });
    expect(outline.symbols).toHaveLength(200); expect(outline.truncated).toBe(true);
    const matches = await execute(createSymbolSearchTool(cwd), { query: "item" });
    expect(matches.matches).toHaveLength(100); expect(matches.truncated).toBe(true);
    const bounded = limitInspectionOutput({ entries: Array.from({ length: 100 }, () => "x".repeat(1_000)), truncated: false });
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(30_000); expect(bounded.truncated).toBe(true);
}), 90_000);

test("new readers honor pre-cancellation and environment check exposes no image or environment values", withFixture(async ({ cwd }) => {
    const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
    await expect(execute(createReadFilesTool(cwd), { files: [{ path: "a" }] }, controller.signal)).rejects.toThrow("fixture cancelled");
    await expect(execute(createFileOutlineTool(cwd), { path: "a.ts" }, controller.signal)).rejects.toThrow("fixture cancelled");
    await expect(execute(createProjectInspectTool(cwd), {}, controller.signal)).rejects.toThrow("fixture cancelled");
    await expect(execute(createSymbolSearchTool(cwd), { query: "name" }, controller.signal)).rejects.toThrow("fixture cancelled");
    await expect(execute(createTestDiscoverTool(cwd), {}, controller.signal)).rejects.toThrow("fixture cancelled");
    await expect(execute(createEnvironmentCheckTool(cwd), {}, controller.signal)).rejects.toThrow("fixture cancelled");
    const previous = process.env.MYAGENT_SANDBOX_IMAGE;
    process.env.MYAGENT_SANDBOX_IMAGE = "private-fixture-image";
    try {
        const result = await execute(createEnvironmentCheckTool(cwd), {});
        expect(result.sandbox).toMatchObject({ configured: true, verified: false, hostExecution: false, dependenciesVerified: false });
        expect(JSON.stringify(result)).not.toContain("private-fixture-image");
    } finally { if (previous === undefined) delete process.env.MYAGENT_SANDBOX_IMAGE; else process.env.MYAGENT_SANDBOX_IMAGE = previous; }
}));
