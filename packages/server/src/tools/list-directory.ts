import { opendir } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative, isSensitivePath } from "../utils/path";
import { toolDeadline } from "../lib/tool-io";

export function createListDirectoryTool(cwd: string) {
    return tool({
        description: "Lista até 500 arquivos/subdiretórios seguros por página; use nextOffset com o diretório inalterado. Examina até 20 mil entradas e exclui links e credenciais.",
        inputSchema: z.object({
            path: z
                .string()
                .optional()
                .describe('Caminho do diretório, relativo ao diretório de trabalho. Padrão: raiz do projeto (".")'),
            offset: z.number().int().min(0).max(20_000).optional(),
            limit: z.number().int().min(1).max(500).optional(),
        }),
        execute: async ({ path, offset = 0, limit = 500 }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal);
            try {
            deadline.signal.throwIfAborted();
            const resolvedPath = await resolveSafePath(cwd, path ?? ".");
            const directory = await opendir(resolvedPath);
            const items: { name: string; type: "directory" | "file" }[] = [];
            let visited = 0, safeEntries = 0, truncated = false;
            for await (const entry of directory) {
                deadline.signal.throwIfAborted();
                if (++visited > 20_000) { truncated = true; break; }
                if (entry.isSymbolicLink() || isSensitivePath(entry.name)) continue;
                if (safeEntries++ < offset) continue;
                if (items.length === limit) { truncated = true; break; }
                items.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
            }
            items.sort((a, b) => {
                    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            return {
                path: toRelative(cwd, resolvedPath),
                entries: items, truncated, nextOffset: truncated && items.length ? offset + items.length : null,
            };
            } finally { deadline.dispose(); }
        }
    });
}
