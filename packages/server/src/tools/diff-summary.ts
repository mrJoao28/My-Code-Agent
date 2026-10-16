import { tool } from "ai";
import { z } from "zod";
import { runGit, safeTrackedFiles } from "../utils/git";
import { limitInspectionOutput } from "../lib/project-inspection";
export function createDiffSummaryTool(cwd: string) {
    return tool({
        description: "Resumo numérico do diff de arquivos seguros rastreados: adições/remoções/binários por arquivo. Working tree ou staged; não inclui untracked e não infere intenção. Até 100 arquivos retornados, mil contabilizados, sem renames ou diff externo.",
        inputSchema: z.object({ path: z.string().max(1_000).optional(), staged: z.boolean().optional() }),
        execute: async ({ path, staged }, { abortSignal }) => {
            const files = await safeTrackedFiles(cwd, path, abortSignal);
            if (!files.length) return { files: [], totalFiles: 0, additions: 0, deletions: 0, binaryFiles: 0, truncated: false };
            const { stdout } = await runGit(cwd, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...(staged ? ["--staged"] : []), "--", ...files], 15_000, abortSignal);
            const entries = stdout.split("\0").filter(Boolean).map(record => {
                const [added, removed, ...name] = record.split("\t");
                return { path: name.join("\t"), additions: added === "-" ? 0 : Number(added), deletions: removed === "-" ? 0 : Number(removed), binary: added === "-" || removed === "-" };
            });
            return limitInspectionOutput({ files: entries.slice(0, 100), totalFiles: entries.length, additions: entries.reduce((n, e) => n + e.additions, 0), deletions: entries.reduce((n, e) => n + e.deletions, 0), binaryFiles: entries.filter(e => e.binary).length, truncated: entries.length > 100 });
        },
    });
}
