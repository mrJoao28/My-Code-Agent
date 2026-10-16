import { tool } from "ai";
import { z } from "zod";
import { readProjectText, inspectionError } from "../lib/project-inspection";
import { toolDeadline } from "../lib/tool-io";

export function createReadFilesTool(cwd: string) {
    return tool({
        description: "Lê de 1 a 8 arquivos seguros, até 1 MiB por arquivo, 4 MiB no lote e 30 mil caracteres de saída. Seleção de linhas é 0-indexed; falhas são individuais e conteúdo abreviado é indicado.",
        inputSchema: z.object({ files: z.array(z.object({ path: z.string().min(1).max(1_000), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2_000).optional() })).min(1).max(8) }),
        execute: async ({ files }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal); let bytes = 0, chars = 0, budgetUsed = 0;
            const results = [];
            try {
                for (const file of files) {
                    deadline.signal.throwIfAborted();
                    if (budgetUsed >= 4 * 1_048_576 || chars >= 30_000) { results.push({ path: file.path, error: "BATCH_LIMIT" }); continue; }
                    const allowance = Math.min(1_048_576, 4 * 1_048_576 - budgetUsed);
                    try {
                        const read = await readProjectText(cwd, file.path, deadline.signal, allowance);
                        bytes += read.bytes; budgetUsed += read.bytes;
                        const lines = read.text.split("\n"), start = file.offset ?? 0;
                        const selected = lines.slice(start, file.limit === undefined ? undefined : start + file.limit).join("\n");
                        const content = selected.slice(0, Math.min(10_000, 30_000 - chars)); chars += content.length;
                        results.push({ path: read.path, content, totalLines: lines.length, truncated: content.length < selected.length });
                    } catch (error) { deadline.signal.throwIfAborted(); budgetUsed += allowance; results.push({ path: file.path, error: inspectionError(error) }); }
                }
                return { files: results, bytesRead: bytes, truncated: results.some(r => r.truncated || r.error === "BATCH_LIMIT") };
            } finally { deadline.dispose(); }
        },
    });
}
