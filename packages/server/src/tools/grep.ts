import { relative, join } from "node:path";
import { readdir, readFile, lstat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, isSensitivePath, UnsafePathError } from "../utils/path";
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const MAX_MATCHES = 200;
export function createGrepTool(cwd: string) {
    return tool({
        description: "Busca regex em arquivos seguros do workspace; exclui links e credenciais. Até 200 resultados.",
        inputSchema: z.object({ pattern: z.string().max(1000), path: z.string().optional(), caseSensitive: z.boolean().optional() }),
        execute: async ({ pattern, path, caseSensitive }, { abortSignal }) => {
            const root = await resolveSafePath(cwd, path ?? ".");
            const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
            const matches: { file: string; line: number; text: string }[] = [];
            let visited = 0, limited = false;
            const visit = async (file: string): Promise<void> => {
                abortSignal?.throwIfAborted();
                if (++visited > 20_000 || matches.length >= MAX_MATCHES) { limited = true; return; }
                let safe: string;
                try { safe = await resolveSafePath(cwd, file); }
                catch (error) { if (error instanceof UnsafePathError) return; throw error; }
                const info = await lstat(safe);
                if (info.isDirectory()) {
                    for (const entry of await readdir(safe, { withFileTypes: true })) {
                        if (entry.isSymbolicLink() || IGNORED.has(entry.name) || isSensitivePath(entry.name)) continue;
                        await visit(join(safe, entry.name));
                        if (limited) break;
                    }
                } else if (info.isFile() && info.size <= 1_000_000) {
                    const content = await readFile(safe, "utf8");
                    for (const [i, line] of content.split("\n").entries()) {
                        regex.lastIndex = 0;
                        if (regex.test(line)) matches.push({ file: relative(cwd, safe).split("\\").join("/"), line: i + 1, text: line.trim().slice(0, 300) });
                        if (matches.length >= MAX_MATCHES) { limited = true; break; }
                    }
                }
            };
            await visit(root);
            return { pattern, matches, truncated: limited };
        },
    });
}
