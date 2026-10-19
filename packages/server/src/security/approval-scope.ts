import { resolveSafePath, toRelative } from "../utils/path";
import { validatePatchPaths } from "../tools/apply-patch";
import type { ApprovalEvent } from "./permissions";
import { SESSION_APPROVAL_FORBIDDEN } from "@myagent/shared";

export async function affectedPaths(cwd: string, name: string, args: ApprovalEvent["args"]): Promise<string[]> {
    let paths: string[] = [];
    if (["write_file", "edit_file", "delete_file"].includes(name)) {
        paths = [String(args.path)];
        if (name === "write_file" && args.backup) paths.push(String(args.path) + ".bak");
    } else if (name === "move_file") paths = [String(args.from), String(args.to)];
    else if (name === "apply_patch") {
        await validatePatchPaths(cwd, String(args.patch));
        paths = String(args.patch).split(/\r?\n/).flatMap(line => {
            const pair = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
            if (pair) return [pair[1]!, pair[2]!];
            const match = line.match(/^(?:--- a\/|\+\+\+ b\/)([^\t]+)(?:\t.*)?$/);
            return match ? [match[1]!] : [];
        });
    }
    paths = [...new Set(paths)];
    if (paths.length > 64) throw new Error("A operação excede o limite de 64 caminhos.");
    return [...new Set(await Promise.all(paths.map(path => resolveSafePath(cwd, path, { mustExist: false })) ))].sort();
}

export async function approvalScope(cwd: string, name: string, args: ApprovalEvent["args"]) {
    const root = await resolveSafePath(cwd, ".");
    let targets: string[];
    let label: string;
    if (name === "web_fetch") {
        const url = new URL(String(args.url));
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("URL pública sem credenciais necessária.");
        targets = [url.origin]; label = `Domínio: ${url.origin}`;
    } else if (["git_push", "git_sync", "git_switch", "git_remote_add"].includes(name)) {
        targets = [root, String(args.branch ?? ""), String(args.remote ?? ""), String(args.url ?? "")];
        label = `Branch: ${args.branch ?? "—"} · Remote: ${args.remote ?? "—"} · URL: ${args.url ?? "—"}`;
    } else {
        targets = await affectedPaths(cwd, name, args);
        label = targets.length ? `Caminhos: ${targets.map(path => toRelative(root, path)).join(", ")}` : "Workspace atual";
        if (!targets.length) targets = [root];
    }
    const canonical = (value: string) => process.platform === "win32" && name !== "web_fetch" ? value.toLowerCase() : value;
    return { key: JSON.stringify([name, canonical(root), ...targets.map(canonical)]), label,
        allowSession: !SESSION_APPROVAL_FORBIDDEN.includes(name) };
}
