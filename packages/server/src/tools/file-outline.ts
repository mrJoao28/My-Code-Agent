import { tool } from "ai";
import { z } from "zod";
import { isSourceFile, readProjectText, InspectionError, limitInspectionOutput } from "../lib/project-inspection";
import { withSourceAnalyzer } from "../lib/source-analysis";
import { toolDeadline } from "../lib/tool-io";
export function createFileOutlineTool(cwd: string) {
    return tool({
        description: "Lista até 200 declarações e linhas de arquivo JS/TS (incluindo JSX/TSX), por AST sintática em worker cancelável. Até 256 KiB/30 segundos. Não resolve tipos/referências nem executa o projeto.",
        inputSchema: z.object({ path: z.string().min(1).max(1_000) }),
        execute: async ({ path }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal, 30_000);
            try {
                if (!isSourceFile(path)) throw new InspectionError("UNSUPPORTED_LANGUAGE");
                const read = await readProjectText(cwd, path, deadline.signal);
                return await withSourceAnalyzer(deadline.signal, async analyze => limitInspectionOutput({ path: read.path, ...await analyze(path, read.text), analysis: "syntax-only" }));
            } finally { deadline.dispose(); }
        },
    });
}
