import { rm } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

export function createDeleteFileTool(cwd: string) {
    return tool({
        description:
            "Apaga um arquivo (ou uma pasta inteira, se recursive=true) dentro do diretório de trabalho. Ação destrutiva e irreversível — use com cuidado e prefira confirmar com o usuário antes de apagar algo importante.",
        inputSchema: z.object({
            path: z.string().describe("Caminho do arquivo ou pasta a apagar, relativo ao diretório de trabalho"),
            recursive: z
                .boolean()
                .optional()
                .describe("Se true, permite apagar uma pasta e todo o seu conteúdo. Padrão: false (só arquivos)")
        }),
        execute: async ({ path, recursive }) => {
            const resolvedPath = await resolveSafePath(cwd, path);

            await rm(resolvedPath, { recursive: recursive ?? false, force: false });

            return {
                path: toRelative(cwd, resolvedPath),
                deleted: true
            };
        }
    });
}