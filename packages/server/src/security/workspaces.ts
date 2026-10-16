import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isInside, resolveSafePath, UnsafePathError } from "../utils/path";
import { workspaceKey } from "../utils/workspace";

let runtimeWorkspace: string | undefined;
export function setRuntimeWorkspace(workspace: string | undefined) { runtimeWorkspace = workspace; }

export function configuredWorkspaces(): string[] {
    if (runtimeWorkspace) return [runtimeWorkspace];
    const value = process.env.MYAGENT_WORKSPACE_ROOTS;
    const roots: unknown = value ? JSON.parse(value) : [process.cwd()];
    if (!Array.isArray(roots) || roots.length === 0 || roots.some(r => typeof r !== "string" || !isAbsolute(r))) throw new Error("MYAGENT_WORKSPACE_ROOTS deve ser um array JSON de diretórios absolutos.");
    return roots as string[];
}

export async function requestWorkspace(requested?: string, authorize = authorizeWorkspace): Promise<string> {
    const workspace = await authorize(requested ?? configuredWorkspaces()[0]!);
    if (runtimeWorkspace && await workspaceKey(workspace) !== await workspaceKey(runtimeWorkspace)) throw new UnsafePathError(workspace);
    return workspace;
}

export async function validateSessionWorkspace(session: { workspacePath: string; cwd: string | null; userId: string }, requested?: string, authorize = authorizeWorkspace) {
    const workspace = await requestWorkspace(requested, authorize);
    if (session.userId !== "local-user" || session.workspacePath !== await workspaceKey(workspace)
        || !session.cwd || await workspaceKey(await authorize(session.cwd)) !== session.workspacePath) {
        throw new UnsafePathError("Sessão não pertence ao workspace autorizado.");
    }
    return workspace;
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
