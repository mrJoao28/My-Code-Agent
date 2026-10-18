import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CONFIG_BYTES = 1024 * 1024;
function fileInfo(path: string) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${basename(path)} precisa ser um arquivo regular, sem links.`);
    return info;
}
/** Verifica permissões antes de ler; não inclui conteúdo de configuração nos erros. */
export function readPrivateConfig(path: string): string | undefined {
    let before;
    try { before = fileInfo(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.ino !== before.ino || info.dev !== before.dev) throw new Error(`${basename(path)} mudou durante a leitura.`);
        if (info.size > MAX_CONFIG_BYTES) throw new Error(`${basename(path)} excede o limite de 1 MiB.`);
        if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
        return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
}
/** Temporário exclusivo no mesmo diretório, sincronizado e substituído por rename. */
export function writePrivateConfig(path: string, content: string, replace = renameSync) {
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new Error(`${basename(path)} excede o limite de 1 MiB.`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Diretório de configuração não pode ser um link.");
    try { fileInfo(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
        fd = openSync(temporary, "wx", 0o600);
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        writeFileSync(fd, content, "utf8"); fsyncSync(fd);
        closeSync(fd); fd = undefined;
        replace(temporary, path);
    } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
}
