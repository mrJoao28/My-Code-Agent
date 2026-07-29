import { resolve, relative } from "path";
import { readdir } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";

function resolveSafePath(cwd: string, targetPath: string) {
    const resolved = resolve(cwd, targetPath);
    const rel = relative(cwd, resolved);
    if (rel.startsWith("..") || resolve(cwd, rel) !== resolved) {
        throw new Error(`Path "${targetPath}" está fora do diretório de trabalho`);
    }
    return resolved;
}

export function createListDirectoryTool(cwd: string) {
    return tool({
        description: "Lista os arquivos e subdiretórios dentro de um diretório.",
        inputSchema: z.object({
            path: z
                .string()
                .optional()
                .describe('Caminho do diretório, relativo ao diretório de trabalho. Padrão: raiz do projeto (".")')
        }),
        execute: async ({ path }) => {
            const resolvedPath = resolveSafePath(cwd, path ?? ".");
            const entries = await readdir(resolvedPath, { withFileTypes: true });

            const items = entries
                .map((entry) => ({
                    name: entry.name,
                    type: entry.isDirectory() ? ("directory" as const) : ("file" as const)
                }))
                .sort((a, b) => {
                    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            return {
                path: relative(cwd, resolvedPath) || ".",
                entries: items
            };
        }
    });
}