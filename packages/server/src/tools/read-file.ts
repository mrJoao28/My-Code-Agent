import { open } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

const MAX_CONTENT_CHARS = 10_000;

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export function createReadFileTool(cwd: string) {
    return tool({
        description: `Lê um arquivo de texto de até ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB, retornando até ${MAX_CONTENT_CHARS} caracteres. offset/limit selecionam linhas, mas não removem o limite do arquivo.`,
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
        execute: async ({ path, offset, limit }, { abortSignal }) => {
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

                let lines = raw.split("\n");
                const totalLines = lines.length;

                if (offset != null || limit != null) {
                    const start = offset ?? 0;
                    const end = limit != null ? start + limit : undefined;
                    lines = lines.slice(start, end);
                }

                let content = lines.join("\n");
                let truncated = false;

                if (content.length > MAX_CONTENT_CHARS) {
                    content = content.slice(0, MAX_CONTENT_CHARS);
                    truncated = true;
                }

                return {
                    path: toRelative(cwd, resolvedPath),
                    content,
                    totalLines,
                    truncated
                };
            } finally {
                await handle.close();
            }
        }
    });
}
