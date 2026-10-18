import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { myagentHome } from "@myagent/shared/home";
import { z } from "zod";
import { isInside, resolveSafePath } from "../utils/path";
import { affectedPaths } from "./approval-scope";
import type { ApprovalEvent } from "./permissions";

export const CHECKPOINT_FILE_BYTES = 5 * 1024 * 1024;
export const CHECKPOINT_STEP_BYTES = 20 * 1024 * 1024;
const STORE_LIMIT = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 48 * 1024 * 1024;
const MUTATIONS = new Set(["write_file", "edit_file", "apply_patch", "move_file", "delete_file"]);
const identifier = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Identificador de sessão inválido."); return id; };
const entrySchema = z.object({ path: z.string().max(4096), kind: z.enum(["file", "directory"]), mode: z.number().int().min(0).max(0o777),
    hash: z.string(), mtime: z.number(), ctime: z.number(), ino: z.number(), data: z.string().max(7 * 1024 * 1024).optional() });
const treeSchema = z.object({ path: z.string(), entries: z.array(entrySchema).max(1000), digest: z.string(), fingerprint: z.string() });
const recordSchema = z.object({ id: z.string(), cwd: z.string(), tool: z.string(), createdAt: z.number(), state: z.enum(["pending", "complete"]),
    before: z.array(treeSchema).max(64), after: z.array(treeSchema).max(64).optional() });
type Tree = z.infer<typeof treeSchema>;
type Record = z.infer<typeof recordSchema>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
export class UndoConflictError extends Error {}
const busyWorkspaces = new Set<string>();
let lastTimestamp = 0;

/** Diretório privado fora do projeto; cada ancestral é verificado antes de criar o próximo. */
async function privateDirectory(path: string) {
    const absolute = resolve(path);
    let cursor = parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
        cursor = join(cursor, part);
        try { await mkdir(cursor, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const info = await lstat(cursor);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Diretório de checkpoints não pode conter links.");
    }
    return absolute;
}
async function boundedRead(path: string, limit: number, signal?: AbortSignal) {
    const input = await open(path, constants.O_RDONLY | noFollow);
    try {
        const stat = await input.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("Checkpoint excede o limite ou não é um arquivo regular seguro.");
        const chunks: Buffer[] = []; let bytes = 0;
        for (;;) {
            signal?.throwIfAborted();
            const buffer = Buffer.alloc(Math.min(65536, limit + 1 - bytes));
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            bytes += bytesRead; if (bytes > limit) throw new Error("Checkpoint excede o limite de leitura.");
            chunks.push(buffer.subarray(0, bytesRead));
        }
        const after = await input.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Arquivo mudou durante a leitura do checkpoint.");
        return { data: Buffer.concat(chunks), stat };
    } finally { await input.close(); }
}
async function atomicFile(path: string, data: Buffer | string, mode = 0o600) {
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    const output = await open(temporary, "wx", mode);
    try {
        await output.writeFile(data);
        if (process.platform !== "win32") await output.chmod(mode);
        await output.close();
        await rename(temporary, path);
    } catch (error) { await output.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
}

async function capture(cwd: string, paths: string[], includeData: boolean, signal?: AbortSignal): Promise<Tree[]> {
    let bytes = 0, count = 0;
    const trees: Tree[] = [];
    for (const root of paths) {
        const entries: Tree["entries"] = [];
        const visit = async (path: string, depth = 0): Promise<void> => {
            signal?.throwIfAborted();
            if (++count > 1000 || depth > 32) throw new Error("Checkpoint excede o limite de 1000 entradas ou 32 níveis.");
            const safe = await resolveSafePath(cwd, path, { mustExist: false });
            const info = await lstat(safe).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
            if (!info) return;
            if (!info.isFile() && !info.isDirectory()) throw new Error("Checkpoint aceita somente arquivos e diretórios regulares.");
            const base = { path: relative(root, safe), mode: info.mode & 0o777, mtime: 0, ctime: 0, ino: 0, hash: "" };
            if (info.isDirectory()) {
                entries.push({ ...base, kind: "directory" });
                const names: string[] = [];
                for await (const child of await opendir(safe)) {
                    signal?.throwIfAborted();
                    if (names.length + count >= 1000) throw new Error("Checkpoint excede o limite de 1000 entradas.");
                    names.push(child.name);
                }
                for (const name of names.sort()) await visit(join(safe, name), depth + 1);
            } else {
                const { data, stat } = await boundedRead(safe, CHECKPOINT_FILE_BYTES, signal);
                bytes += data.length; if (bytes > CHECKPOINT_STEP_BYTES) throw new Error("Checkpoint excede 20 MiB por passo.");
                entries.push({ ...base, kind: "file", hash: hash(data), mtime: stat.mtimeMs, ctime: stat.ctimeMs, ino: stat.ino,
                    ...(includeData && { data: data.toString("base64") }) });
            }
        };
        await visit(root);
        const semantic = entries.map(({ path, kind, mode, hash }) => ({ path, kind, mode, hash }));
        const fingerprint = entries.map(({ data: _, ...entry }) => entry);
        trees.push({ path: relative(cwd, root), entries, digest: hash(JSON.stringify(semantic)), fingerprint: hash(JSON.stringify(fingerprint)) });
    }
    return trees;
}

export class CheckpointStore {
    constructor(private readonly base?: string) {}
    private async directory(sessionId: string) {
        return privateDirectory(join(this.base ?? join(myagentHome(), "checkpoints"), identifier(sessionId)));
    }
    private async files(directory: string) { return (await readdir(directory)).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort(); }
    private async load(directory: string, name: string) {
        const safe = await resolveSafePath(directory, name);
        return recordSchema.parse(JSON.parse((await boundedRead(safe, MAX_RECORD_BYTES)).data.toString("utf8")));
    }
    private async locked<T>(cwd: string, action: (root: string) => Promise<T>): Promise<T> {
        const root = await resolveSafePath(cwd, ".");
        const key = process.platform === "win32" ? root.toLowerCase() : root;
        if (busyWorkspaces.has(key)) throw new Error("Há outra escrita ou restauração nesta pasta; tente novamente.");
        busyWorkspaces.add(key);
        try { return await action(root); } finally { busyWorkspaces.delete(key); }
    }
    async run<T>(cwd: string, sessionId: string, tool: string, args: ApprovalEvent["args"], execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!MUTATIONS.has(tool) || tool === "apply_patch" && args.checkOnly) return execute();
        return this.locked(cwd, async root => {
            const requested = await affectedPaths(root, tool, args);
            const expanded: string[] = [];
            for (const path of requested) {
                let cursor = root;
                for (const part of relative(root, path).split(sep)) {
                    cursor = join(cursor, part);
                    const exists = await lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
                    if (!exists) break;
                }
                if (cursor === root) throw new Error("Não é permitido alterar a raiz do workspace.");
                expanded.push(cursor);
            }
            const paths = [...new Set(expanded)].sort().filter((path, _, all) => !all.some(other => other !== path && isInside(other, path)));
            const before = await capture(root, paths, true, signal);
            if (before.reduce((count, tree) => count + tree.entries.length, 0) + requested.reduce((count, path) => count + relative(root, path).split(sep).length, 0) > 1000) throw new Error("Operação pode exceder 1000 entradas no checkpoint.");
            // Reserva o limite também para conteúdo novo; nunca grava sem conseguir checkpoint.
            const proposedBytes = tool === "write_file" ? Buffer.byteLength(String(args.content)) : tool === "edit_file" ? Buffer.byteLength(String(args.new_str)) : 0;
            if (proposedBytes > CHECKPOINT_FILE_BYTES) throw new Error("Conteúdo novo excede 5 MiB por arquivo de checkpoint.");
            const addition = tool === "apply_patch" ? Buffer.byteLength(String(args.patch)) : proposedBytes;
            if (tool === "edit_file" || tool === "apply_patch") {
                for (const tree of before) for (const entry of tree.entries) {
                    if (entry.kind === "file" && Buffer.from(entry.data!, "base64").length + addition > CHECKPOINT_FILE_BYTES) throw new Error("Edição pode exceder 5 MiB por arquivo de checkpoint.");
                }
            }
            if (before.reduce((size, tree) => size + tree.entries.reduce((n, entry) => n + (entry.data ? Buffer.from(entry.data, "base64").length : 0), 0), 0) + addition * (args.backup ? 2 : 1) > CHECKPOINT_STEP_BYTES) throw new Error("Operação pode exceder 20 MiB por passo.");
            if (requested.some(path => relative(root, path).split(sep).length > 32)) throw new Error("Caminho excede 32 níveis para checkpoint.");
            const directory = await this.directory(sessionId);
            const files = await this.files(directory);
            const serialized = JSON.stringify(before);
            const reservation = Buffer.byteLength(serialized) * 2 + 8 * 1024 * 1024;
            let total = 0;
            for (const name of files) total += (await lstat(await resolveSafePath(directory, name))).size;
            if (reservation > STORE_LIMIT) throw new Error("Checkpoint excede o limite de armazenamento da sessão.");
            while (files.length >= 20 || total + reservation > STORE_LIMIT) {
                const oldest = files.shift()!;
                if ((await this.load(directory, oldest)).state !== "complete") throw new Error("Há checkpoint incompleto; preserve-o antes de continuar.");
                const old = await resolveSafePath(directory, oldest);
                total -= (await lstat(old)).size;
                await unlink(old);
            }
            lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
            const id = `${lastTimestamp}-${randomUUID()}`;
            const record: Record = { id, cwd: root, tool, createdAt: Date.now(), state: "pending", before };
            const filename = join(directory, id + ".json");
            await atomicFile(filename, JSON.stringify(record));
            try {
                signal?.throwIfAborted();
                const verified = await capture(root, paths, false, signal);
                if (verified.some((tree, index) => tree.fingerprint !== before[index]!.fingerprint)) throw new Error("Arquivos mudaram antes da escrita; solicite novamente a ação.");
            } catch (error) { await unlink(filename); throw error; }
            let result!: T, failure: unknown;
            try { result = await execute(); } catch (error) { failure = error; }
            // Mesmo falha/cancelamento pode ter escrito parcialmente: registra o estado real.
            const after = await capture(root, paths, false);
            if (after.every((tree, index) => tree.fingerprint === before[index]!.fingerprint)) await unlink(filename);
            else {
                await atomicFile(filename, JSON.stringify({ ...record, state: "complete", after }));
                if (result && typeof result === "object") result = { ...result, checkpoint: { id, undo: "/undo" } };
            }
            if (failure) throw failure;
            return result;
        });
    }
    async undo(cwd: string, sessionId: string) {
        return this.locked(cwd, async root => {
            const directory = await this.directory(sessionId);
            const files = await this.files(directory);
            const latest = files.at(-1);
            if (!latest) throw new Error("Não há passo para desfazer nesta sessão.");
            const record = await this.load(directory, latest);
            if (record.cwd !== root || record.state !== "complete" || !record.after) throw new Error("Checkpoint incompleto ou de outro workspace; restauração automática recusada.");
            const paths = await Promise.all(record.before.map(tree => resolveSafePath(root, tree.path, { mustExist: false })));
            if (paths.some(path => path === root) || paths.some((path, index) => paths.some((other, j) => index !== j && isInside(other, path)))) throw new Error("Caminhos inválidos no checkpoint.");
            const current = await capture(root, paths, false);
            const conflicts = current.filter((tree, index) => tree.fingerprint !== record.after![index]?.fingerprint).map(tree => tree.path);
            if (conflicts.length) throw new UndoConflictError(`Conflito: arquivos mudaram depois da ação: ${conflicts.join(", ")}. Nenhum arquivo foi restaurado.`);
            // Valida todos os bytes/caminhos armazenados antes de começar a restaurar.
            let bytes = 0;
            if (record.before.reduce((count, tree) => count + tree.entries.length, 0) > 1000) throw new Error("Pré-imagem excede 1000 entradas.");
            for (let index = 0; index < paths.length; index++) for (const entry of record.before[index]!.entries) {
                if (entry.path.split(/[\\/]/).length > 32) throw new Error("Pré-imagem excede 32 níveis.");
                if (!isInside(paths[index]!, resolve(paths[index]!, entry.path))) throw new Error("Caminho inválido na pré-imagem.");
                await resolveSafePath(root, join(paths[index]!, entry.path), { mustExist: false });
                if (entry.kind === "file") {
                    if (entry.data === undefined) throw new Error("Bytes ausentes na pré-imagem.");
                    const data = Buffer.from(entry.data ?? "", "base64"); bytes += data.length;
                    if (hash(data) !== entry.hash || data.length > CHECKPOINT_FILE_BYTES || bytes > CHECKPOINT_STEP_BYTES) throw new Error("Pré-imagem inválida ou acima do limite.");
                }
            }
            for (let index = 0; index < paths.length; index++) {
                const path = paths[index]!;
                await resolveSafePath(root, path, { mustExist: false });
                await rm(path, { recursive: true, force: true });
                for (const entry of record.before[index]!.entries) {
                    const target = await resolveSafePath(root, join(path, entry.path), { mustExist: false });
                    if (entry.kind === "directory") { await mkdir(target, { recursive: true, mode: entry.mode }); if (process.platform !== "win32") await chmod(target, entry.mode); }
                    else { await mkdir(dirname(target), { recursive: true }); await atomicFile(target, Buffer.from(entry.data!, "base64"), entry.mode); }
                }
            }
            await unlink(join(directory, latest));
            // Uma restauração legítima muda inode/mtime; mantém a cadeia de undo verificável.
            if (files.length > 1) {
                const previousName = files.at(-2)!;
                const previous = await this.load(directory, previousName);
                if (previous.state === "complete" && previous.cwd === root && previous.after) {
                    const actual = await capture(root, await Promise.all(previous.after.map(tree => resolveSafePath(root, tree.path, { mustExist: false }))), false);
                    previous.after = previous.after.map((tree, index) => tree.digest === actual[index]!.digest ? actual[index]! : tree);
                    await atomicFile(join(directory, previousName), JSON.stringify(previous));
                }
            }
            return { checkpointId: record.id, paths: record.before.map(tree => tree.path), message: `Passo desfeito: ${record.tool} (${record.before.map(tree => tree.path).join(", ")}).` };
        });
    }
    async prune(active: (sessionId: string) => Promise<boolean>) {
        const base = await privateDirectory(this.base ?? join(myagentHome(), "checkpoints"));
        for (const name of await readdir(base)) {
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) continue;
            const safe = await resolveSafePath(base, name);
            if (!(await lstat(safe)).isDirectory() || await active(name)) continue;
            await rm(safe, { recursive: true, force: true });
        }
    }
}
export const checkpoints = new CheckpointStore();
