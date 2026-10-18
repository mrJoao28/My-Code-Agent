import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readProjectText } from "../../server/src/lib/project-inspection";
import { resolveSafePath } from "../../server/src/utils/path";
import { dockerArguments, runProcess } from "../../server/src/security/sandbox";

export async function detectedTools(cwd: string): Promise<string[]> {
    const exists = async (path: string) => { try { await resolveSafePath(cwd, path); return true; } catch { return false; } };
    const tools = new Set<string>();
    if (await exists("package.json")) {
        try {
            const pkg = JSON.parse((await readProjectText(cwd, "package.json")).text);
            const bun = typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun@") || await exists("bun.lock") || await exists("bun.lockb");
            tools.add(bun ? "bun" : "node");
            if (!bun) tools.add("npm");
            for (const manager of ["pnpm", "yarn"]) {
                if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith(manager + "@")) tools.add(manager);
            }
            const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
            if ("typescript" in dependencies) tools.add("tsc");
            for (const runner of ["vitest", "jest"]) if (runner in dependencies) tools.add(runner);
        } catch { tools.add("node"); }
    }
    if (await exists("tsconfig.json")) tools.add("tsc");
    if (await exists("pyproject.toml") || await exists("requirements.txt") || await exists(".venv")) tools.add("python3");
    if (await exists("pytest.ini") || await exists("conftest.py")) tools.add("pytest");
    if (await exists("go.mod")) tools.add("go");
    if (await exists("Cargo.toml")) tools.add("cargo");
    return [...tools].sort();
}

/** Inspeciona somente a imagem local: não executa código do projeto, não baixa imagem. */
export async function missingImageTools(image: string, tools: string[], run = runProcess): Promise<string[]> {
    if (!tools.length) return [];
    if (tools.some(name => !/^[a-z0-9_-]+$/.test(name))) throw new Error("Nome de ferramenta inválido.");
    const directory = await mkdtemp(join(tmpdir(), "myagent-doctor-"));
    const name = `myagent-doctor-${randomUUID()}`;
    const remove = async () => { await run("docker", ["rm", "--force", name], { timeoutMs: 3_000 }).catch(() => {}); };
    try {
        const command = tools.map(name => `command -v ${name} >/dev/null 2>&1 || printf '%s\\n' ${name}`).join("\n");
        const result = await run("docker", dockerArguments(directory, name, image, command), { timeoutMs: 10_000, onStop: remove });
        if (result.timedOut || result.exitCode !== 0) throw new Error("A imagem não respondeu à verificação de ferramentas.");
        return result.stdout.split(/\r?\n/).filter(name => tools.includes(name));
    } finally { await remove(); await rm(directory, { recursive: true, force: true }); }
}
