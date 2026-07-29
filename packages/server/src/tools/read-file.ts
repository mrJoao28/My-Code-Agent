import { resolve, relative } from "path";
import { readFile } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";

const MAX_FILE_SIZE = 10_000;

function resolveSafePath(cwd: string, targetPath: string) {
    const resolved = resolve(cwd, targetPath);
    const rel = relative(cwd, resolved);
    if (rel.startsWith("..") || resolve(cwd, rel) !== resolved) {
        throw new Error(`Path "${targetPath}" está fora do diretório de trabalho`);
    }
    return resolved;
}

export function createReadFIleTool(cwd: string) {
    return tool({
        description: `Lê o conteúdo de um arquivo de texto. Conteúdo maior que ${MAX_FILE_SIZE} caracteres é truncado.`,
        inputSchema: z.object({
            path: z.string().describe("Caminho do arquivo, relativo ao diretório de trabalho"),
            offset: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Linha inicial (0-indexed) a partir da qual ler"),
            limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Número máximo de linhas a retornar")
        }),
        execute: async ({ path, offset, limit }) => {
            const resolvedPath = resolveSafePath(cwd, path);
            const raw = await readFile(resolvedPath, "utf-8");

            let lines = raw.split("\n");
            const totalLines = lines.length;

            if (offset != null || limit != null) {
                const start = offset ?? 0;
                const end = limit != null ? start + limit : undefined;
                lines = lines.slice(start, end);
            }

            let content = lines.join("\n");
            let truncated = false;

            if (content.length > MAX_FILE_SIZE) {
                content = content.slice(0, MAX_FILE_SIZE);
                truncated = true;
            }

            return {
                path: relative(cwd, resolvedPath) || ".",
                content,
                totalLines,
                truncated
            };
        }
    });
}