import { resolve, relative } from "path";
import { readFile, writeFile } from "fs/promises";
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

export function ccreatedEditFileTool(cwd: string) {
    return tool({
        description:
            "Edita um arquivo substituindo um trecho exato de texto (old_str) por outro (new_str). old_str precisa aparecer exatamente uma vez no arquivo.",
        inputSchema: z.object({
            path: z.string().describe("Caminho do arquivo, relativo ao diretório de trabalho"),
            old_str: z.string().describe("Texto exato a ser substituído — deve casar com exatamente um trecho do arquivo"),
            new_str: z.string().default("").describe("Texto que substitui old_str. Vazio para apenas remover o trecho")
        }),
        execute: async ({ path, old_str, new_str }) => {
            const resolvedPath = resolveSafePath(cwd, path);
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

            const updated = content.replace(old_str, () => new_str);
            await writeFile(resolvedPath, updated, "utf-8");

            return {
                path: relative(cwd, resolvedPath) || ".",
                replaced: true
            };
        }
    });
}