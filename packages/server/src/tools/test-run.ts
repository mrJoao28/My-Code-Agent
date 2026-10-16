import { relative } from "node:path";
import { lstat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath } from "../utils/path";
import { runSandboxCommand } from "../security/sandbox";
const runnerCommands = { bun: ["bun", "test"], node: ["node", "--test"], vitest: ["vitest", "run", "--maxWorkers=1"], jest: ["jest", "--runInBand", "--watch=false"], pytest: ["pytest", "-q", "-p", "no:cacheprovider"] } as const;
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function createTestRunTool(cwd: string, run: typeof runSandboxCommand = runSandboxCommand) {
    return tool({
        description: "Executa Bun/Node/Vitest/Jest/Pytest em Docker aprovado, sem rede/credenciais, sobre cópia descartável em /tmp (64 MiB). Até 10 caminhos, 120 segundos e 20 mil caracteres por stream. Runner/dependências devem existir na imagem; não instala pacotes e não executa no host. Projeto original permanece somente leitura.",
        inputSchema: z.object({ runner: z.enum(["bun", "node", "vitest", "jest", "pytest"]).optional(), path: z.string().max(1_000).optional(), files: z.array(z.string().min(1).max(1_000)).min(1).max(10).optional(), timeoutMs: z.number().int().min(1_000).max(120_000).optional() }),
        execute: async ({ runner = "bun", path, files, timeoutMs = 60_000 }, { abortSignal }) => {
            abortSignal?.throwIfAborted();
            const directory = await resolveSafePath(cwd, path ?? ".");
            if (!(await lstat(directory)).isDirectory()) throw new Error("TEST_PATH_NOT_DIRECTORY");
            const rel = relative(cwd, directory).replaceAll("\\", "/");
            const targets: string[] = [];
            for (const file of files ?? []) {
                const safe = await resolveSafePath(cwd, directory + "/" + file);
                // Keep arguments explicit paths, including filenames beginning with '-'.
                const target = relative(directory, safe).replaceAll("\\", "/");
                if (target === ".." || target.startsWith("../")) throw new Error("TEST_FILE_OUTSIDE_DIRECTORY");
                targets.push("./" + target);
            }
            const command = [
                "testdir=$(mktemp -d /tmp/myagent-tests.XXXXXX) || exit 1",
                'cp -R /workspace/. "$testdir/" || exit 1',
                'cd "$testdir"/' + shellQuote(rel || ".") + " || exit 1",
                [...runnerCommands[runner], ...targets].map(shellQuote).join(" "),
            ].join("\n");
            const result = await run(cwd, command, timeoutMs, abortSignal);
            abortSignal?.throwIfAborted();
            return { runner, path: rel || ".", files: targets, status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
                ...result, note: "Resultado do processo, sem inferir contagem de testes. Códigos não zero incluem falhas de teste, runner/dependências ausentes e limites da cópia temporária." };
        },
    });
}
