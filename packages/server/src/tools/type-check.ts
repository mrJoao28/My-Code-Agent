import { spawn } from "child_process";
import { access } from "fs/promises";
import { join } from "path";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath } from "../utils/path";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 15_000;

const TSC_DIAGNOSTIC_REGEX = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;

type TscDiagnostic = {
    file: string;
    line: number;
    column: number;
    severity: "error" | "warning";
    code: string;
    message: string;
};

function parseTscOutput(output: string): TscDiagnostic[] {
    const diagnostics: TscDiagnostic[] = [];
    for (const line of output.split("\n")) {
        const match = line.match(TSC_DIAGNOSTIC_REGEX);
        if (match) {
            const [, file, lineNum, col, severity, code, message] = match;
            diagnostics.push({
                file: file ?? "",
                line: Number(lineNum),
                column: Number(col),
                severity: severity as "error" | "warning",
                code: code ?? "",
                message: message ?? ""
            });
        }
    }
    return diagnostics;
}

function runTsc(cwd: string, timeoutMs: number): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolvePromise) => {
        const child = spawn("bunx", ["tsc", "--noEmit", "--pretty", "false"], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let settled = false;
        let timedOut = false;
        const chunks: string[] = [];

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString("utf-8")));
        child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString("utf-8")));

        const finish = (exitCode: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({ stdout: chunks.join(""), exitCode, timedOut });
        };

        child.on("error", () => finish(1));
        child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    });
}

export function createTypeCheckTool(cwd: string) {
    return tool({
        description:
            "Roda o verificador de tipos do TypeScript (tsc --noEmit) em um pacote/pasta do projeto e retorna os erros e avisos encontrados, estruturados por arquivo/linha. Use depois de editar arquivos .ts/.tsx para pegar erros de tipagem antes mesmo de rodar a aplicação.",
        inputSchema: z.object({
            path: z
                .string()
                .optional()
                .describe(
                    "Pasta que contém o tsconfig.json a verificar, relativa ao diretório de trabalho (ex: 'packages/server'). Padrão: raiz do diretório de trabalho"
                )
        }),
        execute: async ({ path }) => {
            const targetDir = path ? await resolveSafePath(cwd, path) : cwd;

            const tsconfigPath = join(targetDir, "tsconfig.json");
            try {
                await access(tsconfigPath);
            } catch {
                throw new Error(
                    `Nenhum tsconfig.json encontrado em "${path ?? "."}". Informe o caminho da pasta correta (ex: packages/server).`
                );
            }

            const result = await runTsc(targetDir, DEFAULT_TIMEOUT_MS);
            const diagnostics = parseTscOutput(result.stdout);

            let rawOutput = result.stdout;
            let truncated = false;
            if (rawOutput.length > MAX_OUTPUT_CHARS) {
                rawOutput = rawOutput.slice(0, MAX_OUTPUT_CHARS);
                truncated = true;
            }

            return {
                path: path ?? ".",
                ok: result.exitCode === 0 && !result.timedOut,
                timedOut: result.timedOut,
                errorCount: diagnostics.filter((d) => d.severity === "error").length,
                warningCount: diagnostics.filter((d) => d.severity === "warning").length,
                diagnostics,
                rawOutput,
                truncated
            };
        }
    });
}