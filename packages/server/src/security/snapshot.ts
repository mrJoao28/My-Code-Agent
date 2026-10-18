import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isInside, isSensitivePath, resolveSafePath } from "../utils/path";

export const SNAPSHOT_FILE_LIMIT = 5 * 1024 * 1024;
const OMIT = new Set(["dist", ".dist", "build", "out", "target", ".next", ".nuxt", ".cache", ".turbo", "coverage", "__pycache__"]);
const DEPENDENCIES = new Set(["node_modules", ".venv"]);
export function boundedSetting(name: string, fallback: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`${name}: informe um inteiro entre 1 e ${max}.`);
    return Number(raw);
}
export function snapshotOptions() {
    const flag = process.env.MYAGENT_SANDBOX_DEPENDENCIES;
    if (flag !== undefined && flag !== "0" && flag !== "1") throw new Error("MYAGENT_SANDBOX_DEPENDENCIES deve ser 0 ou 1.");
    return { dependencies: flag === "1", dependencyBytes: boundedSetting("MYAGENT_SANDBOX_DEPENDENCY_MIB", 512, 2048) * 1024 * 1024 };
}
type Entry = { source: string; path: string; size: number; mtime: number; ctime: number; ino: number; mode: number; dependency: boolean; binTarget?: string; directory?: boolean };
type Manifest = { entries: Entry[]; signature: string };
async function manifest(cwd: string, signal?: AbortSignal): Promise<Manifest> {
    const options = snapshotOptions();
    const entries: Entry[] = [];
    let visited = 0, codeBytes = 0, dependencyBytes = 0;
    const walk = async (directory: string, dependency = false, depth = 0): Promise<void> => {
        if (depth > 64) throw new Error("Snapshot excede o limite de profundidade.");
        signal?.throwIfAborted();
        for await (const item of await opendir(directory)) {
            signal?.throwIfAborted();
            if (++visited > (options.dependencies ? 100_000 : 20_000)) throw new Error("Workspace excede o limite de entradas da sandbox.");
            const dep = dependency || DEPENDENCIES.has(item.name);
            if (isSensitivePath(item.name) || !dep && OMIT.has(item.name)) continue;
            if (dep && !options.dependencies) continue;
            const path = join(directory, item.name);
            let source: string;
            if (item.isSymbolicLink()) {
                // Única exceção: executáveis .bin materializados, nunca links no snapshot.
                if (!dep || basename(directory) !== ".bin" || basename(dirname(directory)) !== "node_modules") continue;
                try { source = await resolveSafePath(cwd, resolve(directory, await readlink(path))); }
                catch { continue; }
            } else source = await resolveSafePath(cwd, path);
            const info = await lstat(source);
            if (info.isDirectory() && !item.isSymbolicLink()) {
                entries.push({ source, path: relative(cwd, path), size: 0, mtime: info.mtimeMs, ctime: info.ctimeMs, ino: info.ino, mode: info.mode, dependency: dep, directory: true });
                await walk(source, dep, depth + 1);
            }
            else if (info.isFile() && info.nlink === 1) {
                if (!dep && info.size > SNAPSHOT_FILE_LIMIT) continue;
                if (dep && info.size > 64 * 1024 * 1024) throw new Error("Dependência excede o limite de 64 MiB por arquivo.");
                if (dep) dependencyBytes += info.size; else codeBytes += info.size;
                if (dependencyBytes > options.dependencyBytes || codeBytes > 200 * 1024 * 1024) throw new Error("Snapshot excede os limites de tamanho da sandbox.");
                entries.push({ source, path: relative(cwd, path), size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, ino: info.ino, mode: info.mode, dependency: dep,
                    ...(item.isSymbolicLink() && { binTarget: relative(cwd, source) }) });
            }
        }
    };
    await resolveSafePath(cwd, ".");
    await walk(cwd);
    // Um shim só pode chamar um arquivo que também passou pelo filtro e será copiado.
    const included = new Set(entries.filter(entry => !entry.binTarget && !entry.directory).map(entry => entry.path));
    for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index]!.binTarget && !included.has(entries[index]!.binTarget!)) entries.splice(index, 1);
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { entries, signature: JSON.stringify([options, entries]) };
}
async function copyManifest(cwd: string, destination: string, data: Manifest, signal?: AbortSignal) {
    if (isInside(resolve(cwd), resolve(destination))) throw new Error("Snapshot deve ficar fora do workspace.");
    await mkdir(destination, { recursive: true, mode: 0o755 });
    await chmod(destination, 0o755);
    const executables = new Set(data.entries.flatMap(entry => entry.binTarget ? [entry.binTarget] : []));
    for (const entry of data.entries) {
        signal?.throwIfAborted();
        const safe = await resolveSafePath(cwd, entry.source);
        if (entry.directory) {
            await mkdir(join(destination, entry.path), { recursive: true, mode: 0o755 });
            await chmod(join(destination, entry.path), 0o755);
            continue;
        }
        const input = await open(safe, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
        try {
            const info = await input.stat();
            if (!info.isFile() || info.nlink !== 1 || info.size !== entry.size || info.mtimeMs !== entry.mtime || info.ctimeMs !== entry.ctime || info.ino !== entry.ino) throw new Error("Workspace mudou durante a preparação; tente novamente.");
            const target = join(destination, entry.path);
            await mkdir(dirname(target), { recursive: true, mode: 0o755 });
            const output = await open(target, "wx", 0o600);
            try {
                if (entry.binTarget) {
                    const targetPath = "/workspace/" + entry.binTarget.replaceAll("\\", "/");
                    // Copiar o JS para .bin quebraria imports relativos; o shim chama o original.
                    await output.writeFile("#!/bin/sh\nexec '" + targetPath.replaceAll("'", "'\\''") + "' \"$@\"\n");
                    continue;
                }
                const buffer = Buffer.alloc(64 * 1024);
                let bytes = 0;
                for (;;) {
                    signal?.throwIfAborted();
                    const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
                    if (!bytesRead) break;
                    bytes += bytesRead;
                    if (bytes > entry.size) throw new Error("Arquivo cresceu durante a cópia da sandbox.");
                    let written = 0;
                    while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
                }
                const after = await input.stat();
                if (bytes !== entry.size || after.mtimeMs !== entry.mtime || after.ctimeMs !== entry.ctime) throw new Error("Arquivo mudou durante a cópia da sandbox.");
            } finally {
                await output.close();
                await chmod(target, entry.binTarget || executables.has(entry.path) || entry.mode & 0o111 || /(?:^|[\\/])node_modules[\\/]\.bin[\\/]/.test(entry.path) ? 0o755 : 0o644);
            }
        } finally { await input.close(); }
    }
}
export async function snapshotWorkspace(cwd: string, destination: string, signal?: AbortSignal) {
    await copyManifest(cwd, destination, await manifest(cwd, signal), signal);
}

type Cached = { directory: string; signature: string; timer?: ReturnType<typeof setTimeout>; busy: boolean };
/** Um lease serializa os comandos da mesma sessão; nenhum snapshot ativo é removido. */
export class SnapshotCache {
    private readonly entries = new Map<string, Cached>();
    private readonly queues = new Map<string, Promise<void>>();
    constructor(private readonly ttlMs = 5 * 60_000, private readonly maxEntries = 8) {}
    async acquire(cwd: string, sessionId: string, signal?: AbortSignal) {
        const key = JSON.stringify([await realpath(cwd), sessionId]);
        const previous = this.queues.get(key) ?? Promise.resolve();
        let unlock!: () => void;
        const gate = new Promise<void>(done => { unlock = done; });
        const queued = previous.then(() => gate);
        this.queues.set(key, queued);
        try {
            signal?.throwIfAborted();
            await new Promise<void>((done, reject) => {
                const aborted = () => { signal?.removeEventListener("abort", aborted); reject(signal?.reason ?? new Error("Cancelado")); };
                signal?.addEventListener("abort", aborted, { once: true });
                previous.then(() => { signal?.removeEventListener("abort", aborted); done(); }, reject);
                if (signal?.aborted) aborted();
            });
        } catch (error) {
            unlock();
            void queued.then(() => { if (this.queues.get(key) === queued) this.queues.delete(key); });
            throw error;
        }
        let cached = this.entries.get(key);
        clearTimeout(cached?.timer);
        if (cached) cached.busy = true;
        const finish = () => { unlock(); if (this.queues.get(key) === queued) this.queues.delete(key); };
        try {
            signal?.throwIfAborted();
            const data = await manifest(cwd, signal);
            if (!cached || cached.signature !== data.signature) {
                const directory = await mkdtemp(join(tmpdir(), "myagent-sandbox-"));
                try { await copyManifest(cwd, directory, data, signal); }
                catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
                if (cached) await rm(cached.directory, { recursive: true, force: true });
                cached = { directory, signature: data.signature, busy: true };
                this.entries.set(key, cached);
            }
            // Limita armazenamento retido; entradas em uso continuam protegidas pelo lease.
            for (const [oldKey, old] of this.entries) {
                if (this.entries.size <= this.maxEntries) break;
                if (old.busy || oldKey === key) continue;
                clearTimeout(old.timer); this.entries.delete(oldKey);
                await rm(old.directory, { recursive: true, force: true });
            }
            const active = cached;
            let released = false;
            return { directory: active.directory, release: () => {
                if (released) return;
                released = true; active.busy = false;
                active.timer = setTimeout(() => {
                    if (this.entries.get(key) === active && !active.busy) {
                        this.entries.delete(key);
                        void rm(active.directory, { recursive: true, force: true }).catch(() => {});
                    }
                }, this.ttlMs);
                active.timer.unref(); finish();
            }};
        } catch (error) {
            if (cached) {
                this.entries.delete(key);
                await rm(cached.directory, { recursive: true, force: true }).catch(() => {});
            }
            finish(); throw error;
        }
    }
    async dispose() {
        await Promise.all([...this.queues.values()]);
        const entries = [...this.entries.values()]; this.entries.clear();
        await Promise.all(entries.map(entry => { clearTimeout(entry.timer); return rm(entry.directory, { recursive: true, force: true }); }));
    }
}
