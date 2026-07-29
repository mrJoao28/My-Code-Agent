import { exec } from "child_process";
import { promisify } from "util";
import { tool } from "ai";
import { z } from "zod";

const execAsync = promisify(exec);
const MAX_OUTPUT_SIZE = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function truncate(text: string) {
    if (text.length <= MAX_OUTPUT_SIZE) return { text, truncated: false };
    return { text: text.slice(0, MAX_OUTPUT_SIZE), truncated: true };
}

export function createBashTool(cwd: string) {
    return tool({
        description:
            "Executa um comando de shell dentro do diretório de trabalho do projeto. Use com cautela — comandos destrutivos não são bloqueados automaticamente.",
        inputSchema: z.object({
            command: z.string().describe("Comando de shell a ser executado"),
            timeoutMs: z
                .number()
                .int()
                .positive()
                .max(120_000)
                .optional()
                .describe("Timeout em milissegundos. Padrão: 30000")
        }),
        execute: async ({ command, timeoutMs }) => {
            try {
                const { stdout, stderr } = await execAsync(command, {
                    cwd,
                    timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
                    maxBuffer: 10 * 1024 * 1024
                });

                const out = truncate(stdout);
                const err = truncate(stderr);

                return {
                    stdout: out.text,
                    stderr: err.text,
                    truncated: out.truncated || err.truncated,
                    exitCode: 0
                };
            } catch (e: any) {
                const out = truncate(typeof e.stdout === "string" ? e.stdout : "");
                const err = truncate(typeof e.stderr === "string" ? e.stderr : (e.message ?? String(e)));

                return {
                    stdout: out.text,
                    stderr: err.text,
                    truncated: out.truncated || err.truncated,
                    exitCode: typeof e.code === "number" ? e.code : 1
                };
            }
        }
    });
}