import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit, GitError } from "../utils/git";
import { resolveSafePath, toRelative } from "../utils/path";

export function createGitCommitTool(cwd: string) {
    return tool({
        description: "Cria commit somente dos arquivos explícitos aprovados. Preserva arquivos staged fora dessa lista. Hooks e assinatura externa são desativados. Nunca faz push.",
        inputSchema: z.object({ message: z.string().min(1).max(2000), files: z.array(z.string().min(1)).min(1).max(100) }),
        execute: async ({ message, files }) => {
            await assertGitRepo(cwd);
            const validated = [];
            for (const file of files) {
                const path = await resolveSafePath(cwd, file, { mustExist: false });
                if (toRelative(cwd, path) === ".") throw new GitError("Informe arquivos individuais.");
                const info = await import("node:fs/promises").then(fs => fs.lstat(path).catch(error => {
                    if (error.code === "ENOENT") return null;
                    throw error;
                }));
                if (info?.isDirectory()) throw new GitError("Informe arquivos individuais.");
                validated.push(toRelative(cwd, path));
            }
            await runGit(cwd, ["add", "--", ...validated]);
            await runGit(cwd, ["commit", "--only", "-m", message, "--", ...validated]);
            const { stdout } = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
            return { commitHash: stdout.trim(), message, files: validated };
        },
    });
}
