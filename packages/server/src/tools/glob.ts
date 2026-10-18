import { relative, join } from "node:path";
import { readdir, lstat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, isSensitivePath, UnsafePathError } from "../utils/path";
import { loadSearchIgnore } from "../lib/search-ignore";
export function globToRegExp(pattern: string): RegExp {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern.charAt(i);
        if (c === "*") {
            if (pattern.charAt(i + 1) === "*") {
                i++;
                if (pattern.charAt(i + 1) === "/") { out += "(?:.*/)?"; i++; } else out += ".*";
            } else out += "[^/]*";
        } else if (c === "?") out += "[^/]";
        else out += ".+^$".concat("{}()|[]\\").includes(c) ? "\\" + c : c;
    }
    return new RegExp("^" + out + "$");
}
export function createGlobTool(cwd: string) {
    return tool({
        description: "Busca arquivos seguros por glob (*, **, ?) relativo ao diretório path, até 500 resultados. Respeita o .gitignore da raiz do workspace e a lista fixa de pastas ignoradas; exclui links e credenciais, inclusive ao selecionar um subdiretório.",
        inputSchema: z.object({ pattern: z.string().max(1000), path: z.string().optional() }),
        execute: async ({ pattern, path }, { abortSignal }) => {
            abortSignal?.throwIfAborted();
            const root = await resolveSafePath(cwd, path ?? ".");
            const ignored = await loadSearchIgnore(cwd, abortSignal);
            const matcher = globToRegExp(pattern), matches: string[] = [];
            let visited = 0, truncated = false;
            if (ignored(root, (await lstat(root)).isDirectory())) return { pattern, matches, truncated };
            const walk = async (dir: string): Promise<void> => {
                for (const entry of await readdir(dir, { withFileTypes: true })) {
                    abortSignal?.throwIfAborted();
                    if (++visited > 20_000 || matches.length >= 500) { truncated = true; return; }
                    if (entry.isSymbolicLink() || isSensitivePath(entry.name)) continue;
                    const path = join(dir, entry.name);
                    if (ignored(path, entry.isDirectory())) continue;
                    try { await resolveSafePath(cwd, path); }
                    catch (error) { if (error instanceof UnsafePathError) continue; throw error; }
                    if (entry.isDirectory()) await walk(path);
                    else if (entry.isFile()) {
                        const rel = relative(root, path).split("\\").join("/");
                        if (matcher.test(rel)) matches.push(rel);
                    }
                    if (truncated) return;
                }
            };
            await walk(root);
            return { pattern, matches, truncated };
        },
    });
}
