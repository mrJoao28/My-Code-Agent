import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit, GitError } from "../utils/git";

export function createApplyPatchTool(cwd: string) {
    return tool({
        description:
            "Aplica um diff unificado (formato 'git diff' / 'diff -u', com cabeçalhos --- e +++) de uma vez só, podendo tocar múltiplos arquivos. Use quando a mudança for grande demais para várias chamadas de edit_file.",
        inputSchema: z.object({
            patch: z.string().describe("Conteúdo do diff unificado a aplicar"),
            checkOnly: z
                .boolean()
                .optional()
                .describe("Se true, apenas valida se o patch aplicaria sem erros, sem alterar nenhum arquivo (git apply --check)")
        }),
        execute: async ({ patch, checkOnly }) => {
            await assertGitRepo(cwd);

            const tmpPath = join(tmpdir(), `myagent-patch-${randomUUID()}.diff`);
            await writeFile(tmpPath, patch, "utf-8");

            try {
                const args = ["apply", "--whitespace=nowarn"];
                if (checkOnly) args.push("--check");
                args.push(tmpPath);

                await runGit(cwd, args);

                return {
                    applied: !checkOnly,
                    valid: true
                };
            } catch (e) {
                if (e instanceof GitError) {
                    throw new GitError(`Falha ao aplicar o patch: ${e.message}`);
                }
                throw e;
            } finally {
                await unlink(tmpPath).catch(() => {});
            }
        }
    });
}