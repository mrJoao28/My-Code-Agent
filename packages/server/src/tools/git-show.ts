import { tool } from "ai";
import { z } from "zod";
import { runGit, safeTrackedFiles, truncateOutput } from "../utils/git";
import { resolveCommit, revisionSchema } from "../lib/git-inspection";
export function createGitShowTool(cwd: string) {
    return tool({
        description: "Mostra metadados e patch de commit por hash ou HEAD~N; até 20 mil caracteres. Escopo restrito a caminhos seguros atualmente rastreados (até mil); arquivos históricos removidos do índice não são incluídos. Sem textconv/diff externo/renames.",
        inputSchema: z.object({ revision: revisionSchema.optional(), path: z.string().max(1_000).optional() }),
        execute: async ({ revision, path }, { abortSignal }) => {
            const commit = await resolveCommit(cwd, revision, abortSignal);
            const files = await safeTrackedFiles(cwd, path, abortSignal);
            if (!files.length) return { commit, text: "(nenhum arquivo seguro rastreado neste escopo)", truncated: false };
            const { stdout } = await runGit(cwd, ["show", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--no-notes", "--format=commit %H%nAuthor: %an%nDate: %aI%nSubject: %s", commit, "--", ...files], 15_000, abortSignal);
            return { commit, ...truncateOutput(stdout) };
        },
    });
}
