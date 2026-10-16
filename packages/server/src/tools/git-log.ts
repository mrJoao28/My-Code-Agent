import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit, safeTrackedFiles } from "../utils/git";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function createGitLogTool(cwd: string) {
    return tool({
        description:
            "Lista o histórico de commits do repositório git (hash curto, data, autor e mensagem), do mais recente para o mais antigo. Pode ser filtrado por arquivo/pasta.",
        inputSchema: z.object({
            limit: z
                .number()
                .int()
                .positive()
                .max(MAX_LIMIT)
                .optional()
                .describe(`Número máximo de commits a retornar. Padrão: ${DEFAULT_LIMIT}, máximo: ${MAX_LIMIT}`),
            path: z.string().optional().describe("Limita o histórico a um arquivo ou pasta específica")
        }),
        execute: async ({ limit, path }, { abortSignal }) => {
            await assertGitRepo(cwd, abortSignal);

            const files = await safeTrackedFiles(cwd, path, abortSignal);
            if (files.length === 0) return { commits: [], count: 0 };
            const args = [
                "log", "--no-ext-diff", "--no-textconv",
                "-n",
                String(limit ?? DEFAULT_LIMIT),
                "--pretty=format:%h%x09%ad%x09%an%x09%s",
                "--date=short"
            ];
            args.push("--", ...files);

            const { stdout } = await runGit(cwd, args, 15_000, abortSignal);

            const commits = stdout
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    const [hash, date, author, ...rest] = line.split("\t");
                    return {
                        hash: hash ?? "",
                        date: date ?? "",
                        author: author ?? "",
                        message: rest.join("\t")
                    };
                });

            return { commits, count: commits.length };
        }
    });
}
