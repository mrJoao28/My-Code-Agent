import { dirname, join } from "path";
import { writeFile, mkdir, rename, copyFile, unlink, lstat, link } from "fs/promises";
import { randomUUID } from "crypto";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, toRelative } from "../utils/path";

async function atomicWrite(targetPath: string, content: string, overwrite: boolean): Promise<void> {
    const tmpPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
    try {
        await writeFile(tmpPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
        if (overwrite) await rename(tmpPath, targetPath);
        else { await link(tmpPath, targetPath); await unlink(tmpPath); }
    } catch (e) {
        await unlink(tmpPath).catch(() => {});
        throw e;
    }
}

export function createWriteFileTool(cwd: string) {
    return tool({
        description:
            "Escreve conteúdo em um arquivo. Cria o arquivo (e diretórios pais) caso não existam, ou sobrescreve o conteúdo caso já exista. Passe overwrite=false para exigir que o arquivo não exista ainda, e/ou backup=true para manter uma cópia (.bak) do conteúdo anterior antes de sobrescrever.",
        inputSchema: z.object({
            path: z.string().describe("Caminho do arquivo, relativo ao diretório de trabalho"),
            content: z.string().describe("Conteúdo completo a ser escrito no arquivo"),
            overwrite: z
                .boolean()
                .optional()
                .describe(
                    "Se false, a chamada falha caso o arquivo já exista (proteção explícita contra sobrescrita acidental). Padrão: true, preservando o comportamento histórico da tool."
                ),
            backup: z
                .boolean()
                .optional()
                .describe(
                    "Se true, cria uma cópia do conteúdo anterior em '<path>.bak' antes de sobrescrever um arquivo existente."
                )
        }),
        execute: async ({ path, content, overwrite, backup }) => {
            const shouldOverwrite = overwrite ?? true;
            const resolvedPath = await resolveSafePath(cwd, path, { mustExist: false });

            const existing = await lstat(resolvedPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (existing && !existing.isFile()) throw new Error("O destino precisa ser um arquivo regular.");
            const alreadyExists = existing !== null;

            if (alreadyExists && !shouldOverwrite) {
                throw new Error(
                    `O arquivo "${path}" já existe e overwrite foi definido como false. Passe overwrite: true (padrão) para confirmar a sobrescrita.`
                );
            }

            let backupPath: string | undefined;
            if (alreadyExists && backup) {
                backupPath = await resolveSafePath(cwd, resolvedPath + ".bak", { mustExist: false });
                await copyFile(resolvedPath, backupPath, 1);
            }

            await mkdir(dirname(resolvedPath), { recursive: true });
            await resolveSafePath(cwd, resolvedPath, { mustExist: false });
            await atomicWrite(resolvedPath, content, shouldOverwrite);

            return {
                path: toRelative(cwd, resolvedPath),
                bytesWritten: Buffer.byteLength(content, "utf-8"),
                overwritten: alreadyExists,
                backupPath: backupPath ? toRelative(cwd, backupPath) : undefined
            };
        }
    });
}
