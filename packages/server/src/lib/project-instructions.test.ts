import { expect, test } from "bun:test";
import type { Tool, ToolSet } from "ai";
import { link, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectInstructions, MAX_PROJECT_INSTRUCTION_BYTES } from "./project-instructions";
import { createTools } from "../tools";
import { ApprovalManager } from "../security/permissions";
import { execute, withFixture } from "../test-support";

function buildTool(tools: ReturnType<typeof createTools>, name: "edit_file" | "write_file"): Tool {
    const definition = (tools as ToolSet)[name];
    if (!definition?.execute) throw new Error(`BUILD requires ${name}`);
    return definition;
}

const data = (note: string) => JSON.parse(note.slice(note.indexOf("\n") + 1)) as {
    instructions: { path: string; scope: string; text?: string; truncated?: boolean; status?: string }[]; limited: boolean;
};

test("root and nested instructions are ordered by scope; siblings stay separate and text is delivered once", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src", "deep"), { recursive: true });
    await mkdir(join(cwd, "other"));
    await writeFile(join(cwd, "AGENTS.md"), "Use fixtures. Formato: raiz");
    await writeFile(join(cwd, "src", "AGENTS.md"), "Formato: src");
    await writeFile(join(cwd, "src", "deep", "AGENTS.md"), "Formato: deep");
    await writeFile(join(cwd, "other", "AGENTS.md"), "Outra pasta");
    const instructions = new ProjectInstructions(cwd);
    const root = data(await instructions.root());
    expect(root.instructions).toEqual([{ path: "AGENTS.md", scope: ".", text: "Use fixtures. Formato: raiz", truncated: false }]);
    const note = instructions.note(await instructions.forFiles(["src/deep/a.ts", "src/deep/b.ts"]));
    expect(data(note).instructions.map(i => [i.path, i.scope, i.text])).toEqual([
        ["src/AGENTS.md", "src", "Formato: src"], ["src/deep/AGENTS.md", "src/deep", "Formato: deep"],
    ]);
    expect(note).not.toContain("Outra pasta");
    expect(note).toContain("mais específica prevalece somente em seu escopo");
    expect(instructions.note(await instructions.forFiles(["src/deep/a.ts"]))).toBe("");
}));

test("the total delivered byte budget includes Unicode, escapes and note envelopes, even under parallel loads", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "a")); await mkdir(join(cwd, "b"));
    await writeFile(join(cwd, "AGENTS.md"), "raiz\n".repeat(300));
    await writeFile(join(cwd, "a", "AGENTS.md"), "😀漢\\\n".repeat(20_000));
    await writeFile(join(cwd, "b", "AGENTS.md"), "😀漢\\\n".repeat(20_000));
    const loader = new ProjectInstructions(cwd);
    const notes = [await loader.root()];
    const entries = await Promise.all([loader.forFiles(["a/x.ts"]), loader.forFiles(["b/x.ts"])]);
    notes.push(...entries.map(value => loader.note(value)).filter(Boolean));
    expect(notes.reduce((sum, note) => sum + Buffer.byteLength(note, "utf8"), 0)).toBeLessThanOrEqual(MAX_PROJECT_INSTRUCTION_BYTES);
    expect(notes.some(note => data(note).limited)).toBe(true);
    const all = notes.flatMap(note => data(note).instructions);
    expect(all[0]?.path).toBe("AGENTS.md");
    expect(all.some(item => item.path !== "AGENTS.md" && item.truncated)).toBe(true);
    expect(JSON.stringify(all)).not.toContain("�");
}));

test("cache is immutable within a generation, includes missing files, and resets for the next one", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "AGENTS.md"), "original");
    const first = new ProjectInstructions(cwd);
    expect(await first.root()).toContain("original");
    const entries = await first.forFiles(["src/a.ts"]);
    await writeFile(join(cwd, "AGENTS.md"), "nova raiz");
    await writeFile(join(cwd, "src", "AGENTS.md"), "nova local");
    expect(first.note(entries)).toBe("");
    expect(first.note(await first.forFiles(["src/a.ts"]))).toBe("");
    const next = new ProjectInstructions(cwd);
    expect(await next.root()).toContain("nova raiz");
    expect(next.note(await next.forFiles(["src/a.ts"]))).toContain("nova local");
}));

test("links, junctions, hard links, traversal and sensitive paths cannot supply instructions", withFixture(async ({ cwd, outside }) => {
    await writeFile(join(outside, "AGENTS.md"), "texto externo proibido");
    await symlink(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
    await link(join(outside, "AGENTS.md"), join(cwd, "AGENTS.md"));
    const loader = new ProjectInstructions(cwd);
    expect(await loader.root()).toContain('"status":"blocked"');
    const note = loader.note(await loader.forFiles(["linked/a.ts", "../outside/a.ts", ".env", ".aws/a.ts"]));
    expect(note).not.toContain("texto externo proibido");
    expect(await readFile(join(outside, "AGENTS.md"), "utf8")).toBe("texto externo proibido");
}));

test("a linked AGENTS.md is ignored without following it or blocking ordinary reads", withFixture(async ({ cwd, outside }) => {
    await mkdir(join(cwd, "src"));
    await symlink(outside, join(cwd, "src", "AGENTS.md"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(cwd, "src", "a.ts"), "source");
    const tools = createTools(cwd, "PLAN", "s", { authorize: async () => cwd, sandboxAvailable: false });
    const result = await execute(tools.read_file, { path: "src/a.ts" });
    expect(result.content).toBe("1: source");
    expect((result as unknown as { projectInstructions: string }).projectInstructions).toContain('"status":"blocked"');
}));

test("new paths inherit existing ancestors; missing files and binary instructions are explicit", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "AGENTS.md"), "escopo src");
    const loader = new ProjectInstructions(cwd);
    expect(await loader.root()).toBe("");
    expect(loader.note(await loader.forFiles(["src/new/deep/a.ts"]))).toContain("escopo src");
    await writeFile(join(cwd, "AGENTS.md"), Buffer.from([0, 1, 2]));
    expect(await new ProjectInstructions(cwd).root()).toContain('"status":"unavailable"');
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(new ProjectInstructions(cwd).root(controller.signal)).rejects.toThrow("cancelled");
}));

test("BUILD edits only the requested file, preserves instruction bytes and creates no documentation", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src"));
    const root = "Não crie documentação.\r\n", local = "Preserve este arquivo.\r\n";
    await writeFile(join(cwd, "AGENTS.md"), root);
    await writeFile(join(cwd, "src", "AGENTS.md"), local);
    await writeFile(join(cwd, "src", "a.ts"), "old");
    const manager = new ApprovalManager();
    const tools = createTools(cwd, "BUILD", "s", { manager, authorize: async () => cwd, sandboxAvailable: false,
        notify: async event => { manager.decide("s", event.approvalId, true); } });
    const read = await execute(tools.read_files, { files: [{ path: "src/a.ts" }] });
    expect((read as unknown as { projectInstructions: string }).projectInstructions).toContain("Preserve este arquivo");
    await execute(buildTool(tools, "edit_file"), { path: "src/a.ts", old_str: "old", new_str: "new" });
    expect(await readFile(join(cwd, "src", "a.ts"), "utf8")).toBe("new");
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe(root);
    expect(await readFile(join(cwd, "src", "AGENTS.md"), "utf8")).toBe(local);
    expect((await readdir(cwd)).sort()).toEqual(["AGENTS.md", "src"]);
    expect((await readdir(join(cwd, "src"))).sort()).toEqual(["AGENTS.md", "a.ts"]);
}));

test("unauthorized or denied tools cannot load instructions or mutate files", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "AGENTS.md"), "instrução original");
    const loader = new ProjectInstructions(cwd);
    const tools = createTools(cwd, "BUILD", "s", { authorize: async () => { throw new Error("revoked"); }, sandboxAvailable: false }, loader);
    await expect(execute(tools.read_file, { path: "a.ts" })).rejects.toThrow("revoked");
    await writeFile(join(cwd, "AGENTS.md"), "instrução atualizada");
    expect(await loader.root()).toContain("instrução atualizada");
    const denied = createTools(cwd, "BUILD", "s", { authorize: async () => cwd, sandboxAvailable: false });
    await expect(execute(buildTool(denied, "write_file"), { path: "a.ts", content: "x" })).rejects.toThrow("aprovação");
    expect(await readdir(cwd)).toEqual(["AGENTS.md"]);
}));

test("cancellation during instruction loading prevents a subsequently approved write", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "AGENTS.md"), "dados");
    const controller = new AbortController(), manager = new ApprovalManager();
    class CancelledInstructions extends ProjectInstructions {
        override async forFiles(paths: readonly string[], signal?: AbortSignal) {
            const entries = await super.forFiles(paths, signal);
            controller.abort(new Error("cancelled during loading"));
            return entries;
        }
    }
    const tools = createTools(cwd, "BUILD", "s", { manager, authorize: async () => cwd, sandboxAvailable: false,
        notify: async event => { manager.decide("s", event.approvalId, true); } }, new CancelledInstructions(cwd));
    await expect(execute(buildTool(tools, "write_file"), { path: "a.ts", content: "x" }, controller.signal)).rejects.toThrow("cancelled during loading");
    expect(await readdir(cwd)).toEqual(["AGENTS.md"]);
}));

test("grep and scoped glob attach instructions for files they return", withFixture(async ({ cwd }) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "AGENTS.md"), "Regra das fontes");
    await writeFile(join(cwd, "src", "a.ts"), "needle");
    for (const name of ["grep", "glob"]) {
        const tools = createTools(cwd, "PLAN", "s", { authorize: async () => cwd, sandboxAvailable: false });
        const result = name === "grep" ? await execute(tools.grep, { pattern: "needle", include: "*.ts" })
            : await execute(tools.glob, { pattern: "*.ts", path: "src" });
        const note = (result as unknown as { projectInstructions: string }).projectInstructions;
        expect(data(note).instructions).toContainEqual({ path: "src/AGENTS.md", scope: "src", text: "Regra das fontes", truncated: false });
    }
}));

test("BUILD with no AGENTS.md creates only the requested new file and its parent directories", withFixture(async ({ cwd }) => {
    const manager = new ApprovalManager();
    const tools = createTools(cwd, "BUILD", "s", { manager, authorize: async () => cwd, sandboxAvailable: false,
        notify: async event => { manager.decide("s", event.approvalId, true); } });
    await execute(buildTool(tools, "write_file"), { path: "src/a.ts", content: "requested" });
    expect(await readdir(cwd)).toEqual(["src"]);
    expect(await readdir(join(cwd, "src"))).toEqual(["a.ts"]);
}));
