import { open } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

const MAX_CONTENT_CHARS = 10_000;

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export function createReadFileTool(cwd: string) {
    return tool({
        description: `Lê o conteúdo de um arquivo de texto. Conteúdo maior que ${MAX_CONTENT_CHARS} caracteres é truncado. Arquivos maiores que ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB são rejeitados (use grep/offset+limit para arquivos grandes).`,
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
        execute: async ({ path, offset, limit }) => {
            const resolvedPath = await resolveSafePath(cwd, path);

            const handle = await open(resolvedPath, "r");
            try {
             
                const info = await handle.stat();

                if (!info.isFile()) {
                    throw new Error(`"${path}" não é um arquivo regular`);
                }

                if (info.size > MAX_FILE_SIZE_BYTES) {
                    throw new Error(
                        `Arquivo "${path}" tem ${info.size} bytes, acima do limite de ${MAX_FILE_SIZE_BYTES} bytes. Use offset/limit ou a tool grep em vez de ler o arquivo inteiro.`
                    );
                }

             
                const buffer = Buffer.alloc(info.size);
                await handle.read(buffer, 0, info.size, 0);
                const raw = buffer.toString("utf-8");

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

export const createReadFIleTool = createReadFileTool;
