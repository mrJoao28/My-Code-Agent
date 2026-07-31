import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit, GitError } from "../utils/git";

export function createGitCommitTool(cwd: string) {
    return tool({
        description:
            "Cria um commit git com os arquivos indicados (ou todas as mudanças, se nenhum arquivo for indicado) e a mensagem fornecida. Nunca faz push — isso continua exigindo uma ação manual sua.",
        inputSchema: z.object({
            message: z.string().min(1).describe("Mensagem do commit"),
            files: z
                .array(z.string())
                .optional()
                .describe(
                    "Arquivos específicos a incluir no commit, relativos ao diretório de trabalho. Se omitido, inclui todas as mudanças (git add -A)"
                )
        }),
        execute: async ({ message, files }) => {
            await assertGitRepo(cwd);

            if (files && files.length > 0) {
                await runGit(cwd, ["add", "--", ...files]);
            } else {
                await runGit(cwd, ["add", "-A"]);
            }

            const { stdout: staged } = await runGit(cwd, ["diff", "--cached", "--name-only"]);
            if (!staged.trim()) {
                throw new GitError("Nada para commitar — nenhuma mudança staged.");
            }

            await runGit(cwd, ["commit", "-m", message]);

            const { stdout: hashOut } = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
            const { stdout: filesOut } = await runGit(cwd, ["show", "--name-only", "--pretty=format:", "HEAD"]);

            return {
                commitHash: hashOut.trim(),
                message,
                files: filesOut.split("\n").filter(Boolean)
            };
        }
    });
}