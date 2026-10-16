import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";
import { runGit, safeTrackedFiles, truncateOutput } from "../utils/git";
import { resolveCommit, revisionSchema } from "../lib/git-inspection";
export function createGitBlameTool(cwd: string) {
    return tool({
        description: "Mostra autoria e commit de até 200 linhas de arquivo seguro atualmente rastreado, em commit específico (HEAD por padrão). Linhas são 1-indexed; saída até 20 mil caracteres, sem textconv nem execução do projeto.",
        inputSchema: z.object({ path: z.string().min(1).max(1_000), revision: revisionSchema.optional(), startLine: z.number().int().min(1).max(1_000_000).optional(), limit: z.number().int().min(1).max(200).optional() }),
        execute: async ({ path, revision, startLine = 1, limit = 100 }, { abortSignal }) => {
            // Git may read ignore-revision files before command-line resets apply.
            // Inspect names only, and fail closed without reading those files.
            const config = await runGit(cwd, ["config", "--null", "--name-only", "--list"], 5_000, abortSignal);
            if (config.stdout.split("\0").some(name => name.toLowerCase() === "blame.ignorerevsfile")) throw new Error("UNSAFE_GIT_BLAME_CONFIG: blame.ignoreRevsFile não é suportado nesta ferramenta");
            const safe = await resolveSafePath(cwd, path, { mustExist: false });
            const file = toRelative(cwd, safe).replaceAll("\\", "/");
            const files = await safeTrackedFiles(cwd, file, abortSignal);
            if (!files.includes(file)) throw new Error("FILE_NOT_TRACKED");
            const commit = await resolveCommit(cwd, revision, abortSignal);
            const object = commit + ":" + file;
            const size = Number((await runGit(cwd, ["cat-file", "-s", object], 5_000, abortSignal)).stdout.trim());
            if (!Number.isSafeInteger(size) || size > 1_048_576) throw new Error("BLAME_FILE_TOO_LARGE");
            const content = (await runGit(cwd, ["cat-file", "blob", object], 5_000, abortSignal)).stdout;
            if (content.includes("\0")) throw new Error("BINARY_FILE");
            const lines = content ? content.split("\n").length - Number(content.endsWith("\n")) : 0;
            if (!lines) return { path: file, commit, startLine, text: "", truncated: false };
            if (startLine > lines) throw new Error("LINE_OUT_OF_RANGE");
            await resolveSafePath(cwd, ".mailmap", { mustExist: false });
            const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
            const { stdout } = await runGit(cwd, ["-c", "mailmap.file=" + nullFile, "-c", "mailmap.blob=", "blame", "--ignore-revs-file", "", "--no-textconv", "--line-porcelain", "-L", `${startLine},${Math.min(lines, startLine + limit - 1)}`, commit, "--", file], 15_000, abortSignal);
            const endLine = Math.min(lines, startLine + limit - 1);
            return { path: file, commit, startLine, endLine, totalLines: lines, nextLine: endLine < lines ? endLine + 1 : null, ...truncateOutput(stdout) };
        },
    });
}
