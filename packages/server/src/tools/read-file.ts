import { open } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

const MAX_CONTENT_CHARS = 10_000;

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export function createReadFileTool(cwd: string) {
    return tool({
        description: `Lê texto de até ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB em páginas de linhas completas, até ${MAX_CONTENT_CHARS} caracteres incluindo numeração. numbered=true por padrão: os prefixos 'N: ' não fazem parte do arquivo e não devem ser copiados para old_str. offset é 0-indexed e limit conta linhas. Se houver mais conteúdo, retorna nextOffset e instruções para continuar com offset e limit; omite apenas o final da página, sem saltar trechos. Uma linha que exceda sozinha o limite causa LINE_TOO_LONG. offset/limit não removem o limite de tamanho do arquivo.`,
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
                .describe("Número máximo de linhas a retornar"),
            numbered: z.boolean().default(true).optional().describe("Inclui numeração absoluta das linhas, começando em 1. Padrão: true")
        }),
        execute: async ({ path, offset, limit, numbered }, { abortSignal }) => {
            abortSignal?.throwIfAborted();
            const resolvedPath = await resolveSafePath(cwd, path);

            const handle = await open(resolvedPath, "r");
            try {
             
                const info = await handle.stat();

                if (!info.isFile()) {
                    throw new Error(`"${path}" não é um arquivo regular`);
                }

                if (info.size > MAX_FILE_SIZE_BYTES) {
                    throw new Error(
                        `FILE_TOO_LARGE: arquivo "${path}" tem ${info.size} bytes, acima do limite de ${MAX_FILE_SIZE_BYTES} bytes. Forneça um trecho menor; offset/limit não removem esse limite.`
                    );
                }

             
                const buffer = Buffer.alloc(info.size);
                let bytesRead = 0;
                while (bytesRead < buffer.length) {
                    abortSignal?.throwIfAborted();
                    const chunk = await handle.read(buffer, bytesRead, Math.min(32_768, buffer.length - bytesRead), bytesRead);
                    if (!chunk.bytesRead) break;
                    bytesRead += chunk.bytesRead;
                }
                abortSignal?.throwIfAborted();
                const raw = buffer.subarray(0, bytesRead).toString("utf-8");

                const lines = raw ? raw.split(/\r?\n/) : [];
                const totalLines = lines.length;
                const start = Math.min(offset ?? 0, totalLines);
                const end = Math.min(totalLines, start + (limit ?? totalLines));
                const selected: string[] = [];
                let chars = 0;
                for (let index = start; index < end; index++) {
                    abortSignal?.throwIfAborted();
                    const line = (numbered ?? true) ? `${index + 1}: ${lines[index]!}` : lines[index]!;
                    const cost = line.length + (selected.length ? 1 : 0);
                    if (chars + cost > MAX_CONTENT_CHARS) {
                        if (!selected.length) throw new Error(`LINE_TOO_LONG: linha ${index + 1} excede o limite de ${MAX_CONTENT_CHARS} caracteres; use grep para localizar trechos menores.`);
                        break;
                    }
                    selected.push(line); chars += cost;
                }
                const nextOffset = start + selected.length < totalLines ? start + selected.length : undefined;

                return {
                    path: toRelative(cwd, resolvedPath),
                    content: selected.join("\n"),
                    totalLines,
                    truncated: nextOffset !== undefined,
                    nextOffset,
                    continuation: nextOffset === undefined ? undefined : `Continue com offset=${nextOffset} e limit=${limit ?? Math.max(1, selected.length)}.`
                };
            } finally {
                await handle.close();
            }
        }
    });
}
