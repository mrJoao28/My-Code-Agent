import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit, truncateOutput, safeTrackedFiles } from "../utils/git";

export function createGitDiffTool(cwd: string) {
    return tool({
        description:
            "Mostra o diff das mudanças no repositório git (working tree por padrão, ou staged/index se staged=true). Pode ser limitado a um arquivo ou pasta específica.",
        inputSchema: z.object({
            staged: z
                .boolean()
                .optional()
                .describe("Se true, mostra o diff do que já está staged (git diff --staged) em vez do working tree"),
            path: z
                .string()
                .optional()
                .describe("Limita o diff a um arquivo ou pasta específica, relativo ao diretório de trabalho")
        }),
        execute: async ({ staged, path }, { abortSignal }) => {
            await assertGitRepo(cwd, abortSignal);

            const files = await safeTrackedFiles(cwd, path, abortSignal);
            if (files.length === 0) return { diff: "(sem diferenças)", truncated: false };
            const args = ["diff", "--ignore-submodules=all", "--no-ext-diff", "--no-textconv", "--relative"];
            if (staged) args.push("--staged");
            args.push("--", ...files);

            const { stdout } = await runGit(cwd, args, 15_000, abortSignal);
            const { text, truncated } = truncateOutput(stdout);

            return {
                diff: text || "(sem diferenças)",
                truncated
            };
        }
    });
}
