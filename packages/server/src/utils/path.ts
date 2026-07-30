import { resolve, relative, sep } from "path";
import { realpath } from "fs/promises";


export class UnsafePathError extends Error {
    constructor(targetPath: string) {
        super(`Path "${targetPath}" está fora do diretório de trabalho`);
        this.name = "UnsafePathError";
    }
}

function isInside(root: string, resolved: string): boolean {
    if (resolved === root) return true;
    const rel = relative(root, resolved);
    return !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && rel !== "..";
}


export async function resolveSafePath(
    cwd: string,
    targetPath: string,
    options: { mustExist?: boolean } = {}
): Promise<string> {
    const mustExist = options.mustExist ?? true;

    const root = await realpath(cwd).catch(() => resolve(cwd));
    const resolvedTarget = resolve(root, targetPath);

    if (!isInside(root, resolvedTarget)) {
        throw new UnsafePathError(targetPath);
    }

    try {
        const real = await realpath(resolvedTarget);
        if (!isInside(root, real)) {
            throw new UnsafePathError(targetPath);
        }
        return real;
    } catch (e) {
        if (e instanceof UnsafePathError) throw e;

        if (mustExist) {

            return resolvedTarget;
        }


        const parentDir = resolve(resolvedTarget, "..");
        try {
            const realParent = await realpath(parentDir);
            if (!isInside(root, realParent)) {
                throw new UnsafePathError(targetPath);
            }
        } catch (parentErr) {
            if (parentErr instanceof UnsafePathError) throw parentErr;

        }
        return resolvedTarget;
    }
}


export function toRelative(cwd: string, absolutePath: string): string {
    return relative(cwd, absolutePath) || ".";
}
