import { open, opendir, lstat } from "node:fs/promises";
import { join, extname } from "node:path";
import { resolveSafePath, toRelative, isSensitivePath, UnsafePathError, PathNotFoundError } from "../utils/path";

export class InspectionError extends Error {
    constructor(readonly code: string) { super(code); }
}
export function inspectionError(error: unknown): string {
    if (error instanceof UnsafePathError) return "PATH_BLOCKED";
    if (error instanceof PathNotFoundError || (error as NodeJS.ErrnoException)?.code === "ENOENT") return "NOT_FOUND";
    return error instanceof InspectionError ? error.code : "READ_FAILED";
}
export async function readProjectText(cwd: string, path: string, signal?: AbortSignal, maxBytes = 262_144) {
    signal?.throwIfAborted();
    const safe = await resolveSafePath(cwd, path);
    const handle = await open(safe, "r");
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new InspectionError("NOT_A_FILE");
        if (info.size > maxBytes) throw new InspectionError("FILE_TOO_LARGE");
        const chunks: Buffer[] = []; let bytes = 0;
        while (true) {
            signal?.throwIfAborted();
            const buffer = Buffer.alloc(Math.min(32_768, maxBytes + 1 - bytes));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            bytes += bytesRead;
            if (bytes > maxBytes) throw new InspectionError("FILE_TOO_LARGE");
            chunks.push(buffer.subarray(0, bytesRead));
        }
        signal?.throwIfAborted();
        const data = Buffer.concat(chunks);
        if (data.includes(0)) throw new InspectionError("BINARY_FILE");
        return { path: toRelative(cwd, safe).replaceAll("\\", "/"), text: data.toString("utf8"), bytes };
    } finally { await handle.close(); }
}

/** Streaming traversal: caps entries, depth and retained filenames; never follows links. */
export async function projectFiles(cwd: string, path: string, signal?: AbortSignal) {
    const files: string[] = []; let visited = 0, truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
        signal?.throwIfAborted();
        const safe = await resolveSafePath(cwd, directory);
        const directories: string[] = [];
        for await (const entry of await opendir(safe)) {
            signal?.throwIfAborted();
            if (++visited > 2_000 || files.length >= 500) { truncated = true; return; }
            if (entry.isSymbolicLink() || isSensitivePath(entry.name)
                || ["node_modules", "dist", ".dist", "coverage", ".next", "vendor", "target", "__pycache__"].includes(entry.name)) continue;
            const child = join(safe, entry.name);
            try {
                await resolveSafePath(cwd, child);
                if (entry.isDirectory()) {
                    if (depth >= 12) { truncated = true; continue; }
                    directories.push(child);
                } else if (entry.isFile()) files.push(toRelative(cwd, child).replaceAll("\\", "/"));
            } catch (error) {
                if (!(error instanceof UnsafePathError)) throw error;
            }
        }
        for (const directory of directories) {
            await walk(directory, depth + 1);
            if (visited > 2_000 || files.length >= 500) return;
        }
    };
    const root = await resolveSafePath(cwd, path);
    if ((await lstat(root)).isFile()) files.push(toRelative(cwd, root).replaceAll("\\", "/"));
    else await walk(root, 0);
    return { files: files.sort(), visited, truncated };
}
/** Keep structured output, explicitly marking omitted array entries. */
export function limitInspectionOutput<T extends { truncated: boolean }>(value: T): Omit<T, "truncated"> & { truncated: boolean } {
    while (JSON.stringify(value).length > 30_000) {
        const values: unknown[] = Object.values(value);
        const arrays = values.filter((v): v is unknown[] => Array.isArray(v) && v.length > 0);
        const largest = arrays.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
        if (!largest) throw new InspectionError("OUTPUT_TOO_LARGE");
        largest.splice(Math.floor(largest.length / 2)); value.truncated = true;
    }
    return value;
}
export const isSourceFile = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(extname(path));
export function isTestFile(path: string) {
    return /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go)|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/i.test(path)
        || /(?:^|\/)(?:__tests__|tests?)\/.*\.[cm]?[jt]sx?$/i.test(path);
}
export async function packageInfo(cwd: string, path: string, signal?: AbortSignal) {
    const { text } = await readProjectText(cwd, path, signal);
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new InspectionError("INVALID_PACKAGE_JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InspectionError("INVALID_PACKAGE_JSON");
    const pkg = value as Record<string, unknown>;
    let truncated = false;
    const keys = (field: unknown) => {
        if (!field || typeof field !== "object" || Array.isArray(field)) return [];
        const names = Object.keys(field);
        truncated ||= names.length > 100 || names.some(name => name.length > 200);
        return names.slice(0, 100).map(name => name.slice(0, 200));
    };
    const scripts = keys(pkg.scripts), dependencies = [...new Set([...keys(pkg.dependencies), ...keys(pkg.devDependencies)])];
    return { path, scripts, dependencies: dependencies.slice(0, 100), truncated: truncated || dependencies.length > 100 };
}
