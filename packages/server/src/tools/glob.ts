import { resolve, relative, join } from "path";
import { readdir } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";

function resolveSafePath(cwd: string, targetPath?: string) {
    const resolved = resolve(cwd, targetPath ?? ".");
    const rel = relative(cwd, resolved);
    if (rel.startsWith("..") || resolve(cwd, rel) !== resolved) {
        throw new Error(`Path "${targetPath}" está fora do diretório de trabalho`);
    }
    return resolved;
}

function globToRegExp(pattern: string): RegExp {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern.charAt(i);
        if (c === "*") {
            if (pattern.charAt(i + 1) === "*") {
                out += ".*";
                i++;
                if (pattern.charAt(i + 1) === "/") i++;
            } else {
                out += "[^/]*";
            }
        } else if (c === "?") {
            out += "[^/]";
        } else if (".+^${}()|[]\\".includes(c)) {
            out += "\\" + c;
        } else {
            out += c;
        }
    }
    return new RegExp(`^${out}$`);
}

const DEFAULT_IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const MAX_RESULTS = 500;

async function walk(dir: string, root: string, matcher: RegExp, results: string[]) {
    if (results.length >= MAX_RESULTS) return;

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (DEFAULT_IGNORED.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        const relPath = relative(root, fullPath).split("\\").join("/");

        if (entry.isDirectory()) {
            await walk(fullPath, root, matcher, results);
        } else if (matcher.test(relPath)) {
            results.push(relPath);
        }
    }
}

export function createGlobTool(cwd: string) {
    return tool({
        description:
            "Busca arquivos cujo caminho corresponda a um padrão glob (suporta *, ** e ?). Retorna no máximo 500 resultados.",
        inputSchema: z.object({
            pattern: z.string().describe("Padrão glob, ex: 'src/**/*.ts'"),
            path: z
                .string()
                .optional()
                .describe("Diretório base para a busca, relativo ao diretório de trabalho")
        }),
        execute: async ({ pattern, path }) => {
            const root = resolveSafePath(cwd, path);
            const matcher = globToRegExp(pattern);
            const results: string[] = [];

            await walk(root, root, matcher, results);

            return {
                pattern,
                matches: results,
                truncated: results.length >= MAX_RESULTS
            };
        }
    });
}