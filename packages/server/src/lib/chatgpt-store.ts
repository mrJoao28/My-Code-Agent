import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { localTokenPath } from "@myagent/shared/local-auth";
import { z } from "zod";

const modelSchema = z.object({ slug: z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/), name: z.string().max(200) });
const tokensSchema = z.object({
    access: z.string().min(1).max(32_768), refresh: z.string().min(1).max(32_768),
    id: z.string().min(1).max(32_768), expiresAt: z.number(), scopes: z.array(z.string()),
});
const accountSchema = z.object({
    clientId: z.string().min(1).max(200), subject: z.string().min(1).max(500), label: z.string().max(200),
    tokens: tokensSchema.optional(), models: z.array(modelSchema).max(500).default([]),
});
const stateSchema = z.object({
    hostId: z.string().startsWith("urn:uuid:"), activeId: z.string().optional(), pendingClientId: z.string().max(200).optional(), accounts: z.array(accountSchema).max(50),
});
export type ChatGPTAccount = z.infer<typeof accountSchema>;
export type ChatGPTState = z.infer<typeof stateSchema>;

// Mesmo limite de confiança do token da API: perfil privado/ACLs no Windows e 0600 no POSIX.
export class ChatGPTStore {
    constructor(readonly path = join(dirname(localTokenPath()), "chatgpt-credentials.json")) {}

    private checkDirectory(create: boolean) {
        const directory = resolve(dirname(this.path));
        let cursor = parse(directory).root;
        for (const part of directory.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
            cursor = join(cursor, part);
            try {
                const info = lstatSync(cursor);
                if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Diretório ChatGPT inseguro.");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                if (!create) return;
                mkdirSync(cursor, { mode: 0o700 });
            }
        }
    }
    read(): ChatGPTState {
        this.checkDirectory(false);
        try {
            const info = lstatSync(this.path);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2_000_000
                || process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Arquivo ChatGPT inseguro.");
            return stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Não foi possível ler as credenciais privadas do ChatGPT.");
            return { hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
        }
    }
    write(state: ChatGPTState) {
        this.checkDirectory(true);
        this.read(); // Recusa links, hard links e arquivos existentes inseguros antes da troca atômica.
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            const data = JSON.stringify(stateSchema.parse(state));
            if (Buffer.byteLength(data) > 2_000_000) throw new Error("Armazenamento ChatGPT excedeu o limite permitido.");
            writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
            renameSync(temporary, this.path);
        } finally {
            try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
    }
    async locked<T>(action: () => Promise<T>): Promise<T> {
        this.checkDirectory(true);
        const lock = `${this.path}.lock`;
        let fd: number;
        try { fd = openSync(lock, "wx", 0o600); }
        catch { throw new Error("A conexão ChatGPT está sendo atualizada por outra operação. Tente novamente."); }
        try { return await action(); }
        finally { closeSync(fd); unlinkSync(lock); }
    }
}
