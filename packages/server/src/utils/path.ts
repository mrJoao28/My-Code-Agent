import { resolve, relative, isAbsolute, sep, win32 } from "node:path";
import { lstat, realpath, readdir } from "node:fs/promises";

export class UnsafePathError extends Error {
    constructor(path: string) { super(`Acesso bloqueado ao caminho: ${path}`); this.name = "UnsafePathError"; }
}
export class PathNotFoundError extends Error {
    constructor(path: string) { super(`Path "${path}" não existe`); this.name = "PathNotFoundError"; }
}

export function isInside(root: string, target: string, paths = { relative, isAbsolute, sep }): boolean {
    const rel = paths.relative(root, target);
    return rel === "" || (!paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${paths.sep}`));
}

const PROTECTED_NAMES = new Set([
    ".git", ".aws", ".ssh", ".gnupg", ".azure", ".kube", ".myagent",
    ".docker", ".codex", ".claude", ".config", ".git-credentials", "api-token",
    ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "secrets",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
export function isSensitivePath(path: string): boolean {
    return path.split(/[\\/]/).some(part => {
        const name = part.toLowerCase();
        return PROTECTED_NAMES.has(name)
            || ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example")
            || /\.(pem|key|p12|pfx)$/.test(name)
            || /(?:^|[._-])(?:credentials|secrets?)(?:[._-]|$)/.test(name);
    });
}
function assertNames(path: string): void {
    if (isSensitivePath(path) || path.includes("\0")) throw new UnsafePathError(path);
    for (const name of path.split(/[\\/]/)) {
        if (name.includes(":") || /[. ]$/.test(name) && name !== "." && name !== ".."
            || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new UnsafePathError(path);
    }
}

export async function resolveSafePath(cwd: string, targetPath: string, options: { mustExist?: boolean } = {}): Promise<string> {
    if (targetPath.includes("\0") || (win32.isAbsolute(targetPath) && !isAbsolute(targetPath))) throw new UnsafePathError(targetPath);
    const root = await realpath(cwd);
    if (!(await lstat(root)).isDirectory()) throw new UnsafePathError(cwd);
    const target = resolve(root, targetPath);
    if (!isInside(root, target)) throw new UnsafePathError(targetPath);
    const rel = relative(root, target);
    assertNames(rel);
    // Inspect every existing component. Reject internal links too: no aliases to secrets.
    let cursor = root;
    const components = rel ? rel.split(sep) : [];
    for (let i = 0; i < components.length; i++) {
        cursor = resolve(cursor, components[i]!);
        try {
            const info = await lstat(cursor);
            if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new UnsafePathError(targetPath);
            const canonical = await realpath(cursor);
            if (!isInside(root, canonical)) throw new UnsafePathError(targetPath);
            assertNames(relative(root, canonical));
            if (i < components.length - 1 && !info.isDirectory()) throw new UnsafePathError(targetPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (options.mustExist ?? true) throw new PathNotFoundError(targetPath);
            // Existing ancestors were checked even when multiple final levels are absent.
            return target;
        }
    }
    return target;
}

export async function assertSafeTree(cwd: string, target: string): Promise<void> {
    const safe = await resolveSafePath(cwd, target);
    if (!(await lstat(safe)).isDirectory()) return;
    for (const entry of await readdir(safe)) await assertSafeTree(cwd, resolve(safe, entry));
}
export function toRelative(cwd: string, path: string): string { return relative(cwd, path) || "."; }
