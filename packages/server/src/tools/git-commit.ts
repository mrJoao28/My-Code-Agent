import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit, GitError, commitIdentity } from "../utils/git";
import { resolveSafePath, toRelative } from "../utils/path";

export function createGitCommitTool(cwd: string) {
    return tool({
        description: "Cria commit somente dos arquivos explícitos aprovados. Preserva arquivos staged fora dessa lista. Hooks e assinatura externa são desativados. Nunca faz push.",
        inputSchema: z.object({ message: z.string().min(1).max(2000), files: z.array(z.string().min(1)).min(1).max(100) }),
        execute: async ({ message, files }, { abortSignal }) => {
            await assertGitRepo(cwd, abortSignal);
            const validated = [];
            for (const file of files) {
                abortSignal?.throwIfAborted();
                const path = await resolveSafePath(cwd, file, { mustExist: false });
                if (toRelative(cwd, path) === ".") throw new GitError("Informe arquivos individuais.");
                const info = await import("node:fs/promises").then(fs => fs.lstat(path).catch(error => {
                    if (error.code === "ENOENT") return null;
                    throw error;
                }));
                if (info?.isDirectory()) throw new GitError("Informe arquivos individuais.");
                validated.push(toRelative(cwd, path));
            }
            const identity = await commitIdentity(cwd, abortSignal);
            await runGit(cwd, ["add", "--", ...validated], 15_000, abortSignal);
            await runGit(cwd, [...identity, "commit", "--only", "-m", message, "--", ...validated], 15_000, abortSignal);
            const { stdout } = await runGit(cwd, ["rev-parse", "--short", "HEAD"], 15_000, abortSignal);
            return { commitHash: stdout.trim(), message, files: validated };
        },
    });
}
