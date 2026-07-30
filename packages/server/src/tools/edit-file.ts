import { readFile, writeFile, rename, unlink } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
    const tmpPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
    try {
        await writeFile(tmpPath, content, "utf-8");
        await rename(tmpPath, targetPath);
    } catch (e) {
        await unlink(tmpPath).catch(() => {});
        throw e;
    }
}

export function createEditFileTool(cwd: string) {
    return tool({
        description:
            "Edita um arquivo substituindo um trecho exato de texto (old_str) por outro (new_str). old_str precisa aparecer exatamente uma vez no arquivo.",
        inputSchema: z.object({
            path: z.string().describe("Caminho do arquivo, relativo ao diretório de trabalho"),
            old_str: z.string().describe("Texto exato a ser substituído — deve casar com exatamente um trecho do arquivo"),
            new_str: z.string().default("").describe("Texto que substitui old_str. Vazio para apenas remover o trecho")
        }),
        execute: async ({ path, old_str, new_str }) => {
            const resolvedPath = await resolveSafePath(cwd, path);


            const content = await readFile(resolvedPath, "utf-8");

            const occurrences = countOccurrences(content, old_str);

            if (occurrences === 0) {
                throw new Error("old_str não foi encontrado no arquivo");
            }
            if (occurrences > 1) {
                throw new Error(
                    `old_str aparece ${occurrences} vezes no arquivo — inclua mais contexto para torná-lo único`
                );
            }

            const idx = content.indexOf(old_str);
            const updated = content.slice(0, idx) + new_str + content.slice(idx + old_str.length);

            await atomicWrite(resolvedPath, updated);

            return {
                path: toRelative(cwd, resolvedPath),
                replaced: true
            };
        }
    });
}

export const ccreatedEditFileTool = createEditFileTool;
