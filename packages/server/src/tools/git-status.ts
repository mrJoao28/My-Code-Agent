import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit } from "../utils/git";

const STATUS_CODE_MAP: Record<string, string> = {
    " ": "unchanged",
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
    U: "unmerged",
    "?": "untracked",
    "!": "ignored"
};

function describeStatusCode(code: string): string {
    return STATUS_CODE_MAP[code] ?? code;
}

export function createGitStatusTool(cwd: string) {
    return tool({
        description:
            "Mostra o estado atual do repositório git: branch, arquivos modificados/adicionados/removidos/não rastreados (staged e não staged separadamente), e se há commits à frente/atrás do upstream.",
        inputSchema: z.object({}),
        execute: async () => {
            await assertGitRepo(cwd);

            const { stdout } = await runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
            const lines = stdout.split("\n").filter(Boolean);

            const branchLine = lines.find((l) => l.startsWith("##"));
            const fileLines = lines.filter((l) => !l.startsWith("##"));

            let branch = "unknown";
            let ahead = 0;
            let behind = 0;

            if (branchLine) {
                const match = branchLine.match(
                    /^## ([^ .]+)(?:\.\.\.\S+)?(?: \[ahead (\d+)(?:, behind (\d+))?\])?/
                );
                if (match) {
                    branch = match[1] ?? branch;
                    ahead = match[2] ? Number(match[2]) : 0;
                    behind = match[3] ? Number(match[3]) : 0;
                }
            }

            const files = fileLines.map((line) => {
                const indexStatus = line[0] ?? " ";
                const workTreeStatus = line[1] ?? " ";
                const path = line.slice(3);
                return {
                    path,
                    staged: describeStatusCode(indexStatus),
                    unstaged: describeStatusCode(workTreeStatus)
                };
            });

            return {
                branch,
                ahead,
                behind,
                clean: files.length === 0,
                files
            };
        }
    });
}