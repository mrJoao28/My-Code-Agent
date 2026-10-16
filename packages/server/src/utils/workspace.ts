import { realpath, lstat } from "node:fs/promises";
import { resolve, parse } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isInside, resolveSafePath, UnsafePathError } from "./path";
import { gitEnvironment } from "./git";

const execute = promisify(execFile);

async function safeDirectory(dir: string): Promise<string> {
    const absolute = resolve(dir);
    // Valida inclusive os ancestrais do workspace, antes de canonicalizar links.
    await resolveSafePath(parse(absolute).root, absolute);
    if (!(await lstat(absolute)).isDirectory()) throw new UnsafePathError(dir);
    return realpath(absolute);
}

export async function workspaceKey(dir: string): Promise<string> {
    const canonical = await safeDirectory(dir);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function workspaceTitle(dir: string): Promise<string> { return safeDirectory(dir); }

export async function resolveWorkspaceRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    const directory = await safeDirectory(cwd);
    try {
        const { stdout } = await execute("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
            timeout: 5_000, maxBuffer: 32_768, windowsHide: true, env: gitEnvironment(), signal,
        });
        const root = await safeDirectory(stdout.trim());
        if (!isInside(root, directory)) throw new UnsafePathError(root);
        return root;
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof UnsafePathError) throw error;
        const failure = error as { code?: number | string; stderr?: string };
        if (failure.code === "ENOENT" || failure.code === 128 && failure.stderr?.includes("not a git repository")) return directory;
        throw new Error("Não foi possível identificar a raiz Git da pasta.", { cause: error });
    }
}
