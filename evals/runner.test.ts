import { expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparison, parseEvalOptions } from "./runner";
import { prepareTask, tasks, verifyTask } from "./tasks";
import { withFixture } from "../packages/server/src/test-support";
import { removeEvalRoot } from "./cleanup";
import { tmpdir } from "node:os";

test("Windows cleanup retries transient locks after collection and refuses paths outside its temporary roots", async () => {
    let attempts = 0, collections = 0;
    await removeEvalRoot(join(tmpdir(), "myagent-eval-cleanup-regression"), {
        remove: async () => { if (attempts++ < 2) throw Object.assign(new Error("locked"), { code: "EBUSY" }); },
        collect: () => { collections++; }, wait: async () => {},
    });
    expect(attempts).toBe(3); expect(collections).toBe(2);
    let nativeCalls = 0;
    await removeEvalRoot(join(tmpdir(), "myagent-eval-cleanup-native"), {
        remove: async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); },
        collect: () => {}, wait: async () => {}, native: async () => { nativeCalls++; return true; },
    });
    expect(nativeCalls).toBe(1);
    await expect(removeEvalRoot(join(tmpdir(), "not-owned"))).rejects.toThrow("inválido");
});

test("eval requires models, accepts two models and does not treat missing token usage as zero", () => {
    expect(parseEvalOptions(["--model", "a", "--model", "b"]).models).toEqual(["a", "b"]);
    expect(parseEvalOptions(["--simulate"])).toMatchObject({ simulate: true, models: ["simulado-a", "simulado-b"] });
    expect(parseEvalOptions(["--simulate", "--bundle"]).bundle).toBe(true);
    expect(() => parseEvalOptions(["--simulate", "--model", "gpt-5.4"])).toThrow("somente simulado");
    for (const args of [[], ["--model"], ["--task", "unknown"], ["--model", "a", "--model", "a"]]) expect(() => parseEvalOptions(args)).toThrow();
    const table = comparison([{ model: "a", task: "x", passed: true, reason: "ok", toolCalls: 2, totalTokens: 100, durationMs: 1000, exitCode: 0 }, { model: "b", task: "x", passed: false, reason: "erro", toolCalls: 3, totalTokens: null, durationMs: 2000, exitCode: 1 }]);
    expect(table).toContain("| a | 1/1 (100%) | 2 | 100 | 1.0 |");
    expect(table).toContain("| b | 0/1 (0%) | 3 | 0 + não informado | 2.0 |");
});

test("nine verifiable fixtures reject wrong answers, unintended files, CRLF loss and executable-mode loss", withFixture(async ({ cwd }) => {
    expect(tasks).toHaveLength(9);
    for (const task of tasks) {
        const workspace = join(cwd, task.id);
        await prepareTask(task, workspace);
        for (const [path, content] of Object.entries(task.expected ?? {})) {
            await mkdir(join(workspace, path, ".."), { recursive: true });
            await writeFile(join(workspace, path), content);
        }
        const calls = task.id === "multiplas-leituras" ? Array.from({ length: 30 }, (_, i) => ({ toolName: "read_file", args: { path: `parts/${String(i + 1).padStart(2, "0")}.txt` } })) : [{ toolName: "grep", args: {} }];
        expect((await verifyTask(task, workspace, task.answer ?? "", calls)).passed).toBe(true);
        expect((await verifyTask(task, workspace, task.answer ?? "", [...calls, { toolName: "git_commit", args: {} }])).passed).toBe(false);
        if (task.id === "corrigir-bug") {
            await writeFile(join(workspace, "src/sum.ts"), task.expected!["src/sum.ts"]! + "\u0000");
            expect((await verifyTask(task, workspace, "", calls)).passed).toBe(false);
            await writeFile(join(workspace, "src/sum.ts"), task.expected!["src/sum.ts"]!);
        }
        if (task.answer) expect((await verifyTask(task, workspace, "resposta incorreta", calls)).passed).toBe(false);
        if (task.id === "refatorar-crlf") {
            await writeFile(join(workspace, "src/title.ts"), task.expected!["src/title.ts"]!.replace(/\r\n/g, "\n"));
            expect((await verifyTask(task, workspace, "", calls)).passed).toBe(false);
        }
        if (task.executable && process.platform !== "win32") {
            await chmod(join(workspace, task.executable), 0o600);
            expect((await verifyTask(task, workspace, "", calls)).passed).toBe(false);
        }
        await writeFile(join(workspace, "RESUME.md"), "não solicitado");
        expect((await verifyTask(task, workspace, task.answer ?? "", calls)).passed).toBe(false);
    }
}), 30_000);
