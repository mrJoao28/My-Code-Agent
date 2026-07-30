import { relative, join } from "path";
import { readdir, readFile, stat } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath } from "../utils/path";

const DEFAULT_IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const MAX_MATCHES = 200;
const MAX_FILE_SIZE = 1_000_000; 

async function collectFiles(dir: string, files: string[]) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        if (DEFAULT_IGNORED.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
            await collectFiles(fullPath, files);
        } else {
            files.push(fullPath);
        }
    }
}

export function createGrepTool(cwd: string) {
    return tool({
        description:
            "Busca um padrão (regex) no conteúdo dos arquivos de um diretório. Retorna no máximo 200 ocorrências, com arquivo, número da linha e trecho.",
        inputSchema: z.object({
            pattern: z.string().describe("Expressão regular (sintaxe JS) a ser buscada"),
            path: z
                .string()
                .optional()
                .describe("Diretório base para a busca, relativo ao diretório de trabalho"),
            caseSensitive: z
                .boolean()
                .optional()
                .describe("Se a busca diferencia maiúsculas/minúsculas. Padrão: false")
        }),
        execute: async ({ pattern, path, caseSensitive }) => {
            const root = await resolveSafePath(cwd, path ?? ".");
            const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");

            const files: string[] = [];
            await collectFiles(root, files);

            const matches: { file: string; line: number; text: string }[] = [];

            for (const filePath of files) {
                if (matches.length >= MAX_MATCHES) break;

                let content: string;
                try {
                    const info = await stat(filePath);
                    if (info.size > MAX_FILE_SIZE) continue;
                    content = await readFile(filePath, "utf-8");
                } catch {
                    continue; 
                }

                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    if (matches.length >= MAX_MATCHES) break;
                    const line = lines[i] ?? "";
                    regex.lastIndex = 0;
                    if (regex.test(line)) {
                        matches.push({
                            file: relative(cwd, filePath).split("\\").join("/"),
                            line: i + 1,
                            text: line.trim().slice(0, 300)
                        });
                    }
                }
            }

            return {
                pattern,
                matches,
                truncated: matches.length >= MAX_MATCHES
            };
        }
    });
}
