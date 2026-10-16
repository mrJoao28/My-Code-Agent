import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { assertGitRepo, runGit } from "../utils/git";
import { resolveSafePath, UnsafePathError } from "../utils/path";

export async function validatePatchPaths(cwd: string, patch: string): Promise<void> {
    if (/^(?:rename |copy |GIT binary patch|Binary files )/m.test(patch) || /^(?:new file mode|old mode|new mode|deleted file mode|index ).*120000/m.test(patch)) {
        throw new Error("Patch binário, de symlink, rename ou copy não é permitido; use ferramentas de arquivos.");
    }
    let headers = 0;
    const check = async (path: string, prefix: string) => {
        if (path === "/dev/null") return;
        if (!path.startsWith(prefix) || /\s/.test(path)) throw new UnsafePathError(path);
        const safe = await resolveSafePath(cwd, path.slice(2), { mustExist: false });
        if (safe === await resolveSafePath(cwd, ".")) throw new UnsafePathError(path);
    };
    for (const line of patch.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            const match = line.match(/^diff --git (\S+) (\S+)$/);
            if (!match) throw new Error("Use edit_file para nomes de arquivo com espaços ou escape.");
            await check(match[1]!, "a/"); await check(match[2]!, "b/");
        } else if (line.startsWith("--- ")) { headers++; await check(line.slice(4).split("\t")[0]!, "a/"); }
        else if (line.startsWith("+++ ")) { headers++; await check(line.slice(4).split("\t")[0]!, "b/"); }
    }
    if (headers < 2) throw new Error("Patch deve conter cabeçalhos --- a/ e +++ b/.");
}
export function createApplyPatchTool(cwd: string) {
    return tool({
        description: "Aplica diff unificado a arquivos seguros do workspace, com aprovação. Não aceita binários, links, rename/copy ou paths com espaços.",
        inputSchema: z.object({ patch: z.string().max(500_000), checkOnly: z.boolean().optional() }),
        execute: async ({ patch, checkOnly }, { abortSignal }) => {
            abortSignal?.throwIfAborted();
            await validatePatchPaths(cwd, patch);
            await assertGitRepo(cwd, abortSignal);
            const temporary = join(tmpdir(), "myagent-patch-" + randomUUID() + ".diff");
            await writeFile(temporary, patch, { flag: "wx", mode: 0o600, encoding: "utf8" });
            try {
                await runGit(cwd, ["apply", "--check", "--whitespace=nowarn", temporary], 15_000, abortSignal);
                if (!checkOnly) {
                    await validatePatchPaths(cwd, patch);
                    await runGit(cwd, ["apply", "--whitespace=nowarn", temporary], 15_000, abortSignal);
                }
                return { applied: !checkOnly, valid: true };
            } finally { await unlink(temporary).catch(() => {}); }
        },
    });
}
