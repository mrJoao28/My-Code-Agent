import { resolve, relative, dirname } from "path";
import { writeFile, mkdir } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";

function resolveSafePath(cwd: string, targetPath: string) {
    const resolved = resolve(cwd, targetPath);
    const rel = relative(cwd, resolved);
    if (rel.startsWith("..") || resolve(cwd, rel) !== resolved) {
        throw new Error(`Path "${targetPath}" está fora do diretório de trabalho`);
    }
    return resolved;
}

export function createWriteFIleTool(cwd: string) {
    return tool({
        description:
            "Escreve conteúdo em um arquivo. Cria o arquivo (e diretórios pais) caso não existam, ou sobrescreve o conteúdo caso já exista.",
        inputSchema: z.object({
            path: z.string().describe("Caminho do arquivo, relativo ao diretório de trabalho"),
            content: z.string().describe("Conteúdo completo a ser escrito no arquivo")
        }),
        execute: async ({ path, content }) => {
            const resolvedPath = resolveSafePath(cwd, path);

            await mkdir(dirname(resolvedPath), { recursive: true });
            await writeFile(resolvedPath, content, "utf-8");

            return {
                path: relative(cwd, resolvedPath) || ".",
                bytesWritten: Buffer.byteLength(content, "utf-8")
            };
        }
    });
}