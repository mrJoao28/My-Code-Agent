import { readFile, open, rename, unlink, lstat } from "fs/promises";
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

function dominantEol(content: string): string {
    let lf = 0, crlf = 0, first = "";
    for (const match of content.matchAll(/\r?\n/g)) {
        first ||= match[0];
        if (match[0] === "\r\n") crlf++; else lf++;
    }
    return crlf > lf ? "\r\n" : lf > crlf ? "\n" : first || "\n";
}

// Converte o índice da busca normalizada sem regravar os trechos não editados.
function originalOffset(content: string, offset: number): number {
    if (!content.includes("\r\n")) return offset;
    let original = 0;
    for (let normalized = 0; normalized < offset; normalized++, original++) {
        if (content[original] === "\r" && content[original + 1] === "\n") original++;
    }
    return original;
}

async function atomicWrite(targetPath: string, content: string, mode: number): Promise<void> {
    const tmpPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
    try {
        const handle = await open(tmpPath, "wx", mode);
        try {
            await handle.writeFile(content, "utf-8");
            // Usa o descritor para restaurar a umask sem seguir outro caminho.
            if (process.platform !== "win32") await handle.chmod(mode);
        } finally { await handle.close(); }
        await rename(tmpPath, targetPath);
    } catch (e) {
        await unlink(tmpPath).catch(() => {});
        throw e;
    }
}

export function createEditFileTool(cwd: string) {
    return tool({
        description:
            "Edita um arquivo substituindo old_str por new_str. A busca ignora diferenças LF/CRLF, mas exige exatamente uma ocorrência e informa a contagem em caso de erro. new_str usa o fim de linha dominante do arquivo (primeiro em caso de empate); preserva permissões existentes.",
        inputSchema: z.object({
            path: z.string().describe("Caminho do arquivo, relativo ao diretório de trabalho"),
            old_str: z.string().min(1).describe("Texto exato a substituir, ignorando apenas diferenças LF/CRLF; precisa ocorrer uma única vez"),
            new_str: z.string().default("").describe("Texto que substitui old_str. Vazio para apenas remover o trecho")
        }),
        execute: async ({ path, old_str, new_str }) => {
            const resolvedPath = await resolveSafePath(cwd, path);


            const info = await lstat(resolvedPath);
            if (!info.isFile()) throw new Error("O destino precisa ser um arquivo regular.");
            const content = await readFile(resolvedPath, "utf-8");
            const normalized = content.replace(/\r\n/g, "\n");
            const search = old_str.replace(/\r\n/g, "\n");

            const occurrences = countOccurrences(normalized, search);

            if (occurrences !== 1) {
                throw new Error(`old_str: ${occurrences} ocorrências encontradas no arquivo; é necessário exatamente 1. Inclua contexto suficiente para identificar um trecho único.`);
            }

            const idx = normalized.indexOf(search);
            const start = originalOffset(content, idx), end = originalOffset(content, idx + search.length);
            const replacement = new_str.replace(/\r?\n/g, dominantEol(content));
            const updated = content.slice(0, start) + replacement + content.slice(end);

            await resolveSafePath(cwd, resolvedPath);
            await atomicWrite(resolvedPath, updated, info.mode & 0o777);

            return {
                path: toRelative(cwd, resolvedPath),
                replaced: true
            };
        }
    });
}
