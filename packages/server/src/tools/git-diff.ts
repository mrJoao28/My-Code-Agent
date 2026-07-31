import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit, truncateOutput } from "../utils/git";

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
        execute: async ({ staged, path }) => {
            await assertGitRepo(cwd);

            const args = ["diff"];
            if (staged) args.push("--staged");
            if (path) args.push("--", path);

            const { stdout } = await runGit(cwd, args);
            const { text, truncated } = truncateOutput(stdout);

            return {
                diff: text || "(sem diferenças)",
                truncated
            };
        }
    });
}