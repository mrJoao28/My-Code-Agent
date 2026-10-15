import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isInside, resolveSafePath, UnsafePathError } from "../utils/path";

export function configuredWorkspaces(): string[] {
    const value = process.env.MYAGENT_WORKSPACE_ROOTS;
    const roots: unknown = value ? JSON.parse(value) : [process.cwd()];
    if (!Array.isArray(roots) || roots.length === 0 || roots.some(r => typeof r !== "string" || !isAbsolute(r))) throw new Error("MYAGENT_WORKSPACE_ROOTS deve ser um array JSON de diretórios absolutos.");
    return roots as string[];
}
export async function authorizeWorkspace(cwd: string, roots = configuredWorkspaces()): Promise<string> {
    if (!isAbsolute(cwd)) throw new UnsafePathError(cwd);
    const canonical = await realpath(cwd);
    if (!(await stat(canonical)).isDirectory()) throw new UnsafePathError(cwd);
    for (const configured of roots) {
        const root = await realpath(configured);
        if (isInside(root, canonical)) { await resolveSafePath(root, cwd); return canonical; }
    }
    throw new UnsafePathError(cwd);
}
