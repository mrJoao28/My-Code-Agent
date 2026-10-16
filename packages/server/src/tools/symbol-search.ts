import { tool } from "ai";
import { z } from "zod";
import { projectFiles, readProjectText, isSourceFile, inspectionError, limitInspectionOutput } from "../lib/project-inspection";
import { withSourceAnalyzer, type SourceSymbol } from "../lib/source-analysis";
import { toolDeadline } from "../lib/tool-io";
export function createSymbolSearchTool(cwd: string) {
    return tool({
        description: "Busca literal por nome de declaração JS/TS via AST; não encontra todas as referências. Até 100 arquivos, 2 MiB totais, 256 KiB/arquivo, 100 resultados e 30 segundos; exclusões e limites são indicados.",
        inputSchema: z.object({ query: z.string().trim().min(1).max(200), path: z.string().max(1_000).optional(), caseSensitive: z.boolean().optional() }),
        execute: async ({ query, path, caseSensitive }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal, 30_000);
            try {
                const scan = await projectFiles(cwd, path ?? ".", deadline.signal);
                const sources = scan.files.filter(isSourceFile), matches: (SourceSymbol & { path: string })[] = [], errors: { path: string; error: string }[] = [];
                let bytes = 0, inspected = 0, truncated = scan.truncated || sources.length > 100;
                await withSourceAnalyzer(deadline.signal, async analyze => {
                    for (const file of sources.slice(0, 100)) {
                        if (bytes >= 2_097_152 || matches.length >= 100) { truncated = true; break; }
                        try {
                            const read = await readProjectText(cwd, file, deadline.signal, Math.min(262_144, 2_097_152 - bytes)); bytes += read.bytes; inspected++;
                            const result = await analyze(file, read.text, query, caseSensitive);
                            truncated ||= result.truncated || matches.length + result.symbols.length > 100;
                            matches.push(...result.symbols.slice(0, 100 - matches.length).map(s => ({ path: file, ...s })));
                        } catch (error) { deadline.signal.throwIfAborted(); bytes += 262_144; errors.push({ path: file, error: inspectionError(error) }); truncated = true; }
                    }
                });
                return limitInspectionOutput({ matches, inspected, errors, truncated, analysis: "syntax-only" });
            } finally { deadline.dispose(); }
        },
    });
}
