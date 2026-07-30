import { readdir } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

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
            const resolvedPath = await resolveSafePath(cwd, path ?? ".");
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
                path: toRelative(cwd, resolvedPath),
                entries: items
            };
        }
    });
}
