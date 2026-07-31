import { rename, mkdir, access } from "fs/promises";
import { dirname } from "path";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export function createMoveFileTool(cwd: string) {
    return tool({
        description: "Move ou renomeia um arquivo/pasta dentro do diretório de trabalho.",
        inputSchema: z.object({
            from: z.string().describe("Caminho de origem, relativo ao diretório de trabalho"),
            to: z.string().describe("Caminho de destino, relativo ao diretório de trabalho"),
            overwrite: z.boolean().optional().describe("Se false (padrão), falha caso o destino já exista")
        }),
        execute: async ({ from, to, overwrite }) => {
            const resolvedFrom = await resolveSafePath(cwd, from);
            const resolvedTo = await resolveSafePath(cwd, to, { mustExist: false });

            if (!overwrite && (await pathExists(resolvedTo))) {
                throw new Error(`O destino "${to}" já existe. Passe overwrite: true para confirmar a sobrescrita.`);
            }

            await mkdir(dirname(resolvedTo), { recursive: true });
            await rename(resolvedFrom, resolvedTo);

            return {
                from: toRelative(cwd, resolvedFrom),
                to: toRelative(cwd, resolvedTo)
            };
        }
    });
}