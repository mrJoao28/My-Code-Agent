import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveSafePath, UnsafePathError } from "./path";
const execFileAsync = promisify(execFile);
export class GitError extends Error {}

export function gitEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1" };
    for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[name]) env[name] = process.env[name];
    return env;
}
async function assertMetadata(cwd: string, initializing: boolean): Promise<void> {
    const directory = join(cwd, ".git");
    try {
        const root = await lstat(directory);
        if (!root.isDirectory() || root.isSymbolicLink()) throw new GitError("Git requer .git local sem links; worktrees com metadata externo não são suportadas.");
    } catch (error) {
        if (initializing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    let visited = 0;
    const walk = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
            if (++visited > 20_000) throw new GitError("Metadata Git excede o limite de validação.");
            const file = join(path, entry.name), info = await lstat(file);
            if (info.isSymbolicLink() || info.isFile() && info.nlink > 1
                || file === join(directory, "commondir") || file === join(directory, "objects", "info", "alternates")) {
                throw new GitError("Metadata Git externo ou compartilhado não é permitido.");
            }
            if (info.isDirectory()) await walk(file);
        }
    };
    await walk(directory);
}
export async function runGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
    const nullPath = process.platform === "win32" ? "NUL" : "/dev/null";
    try {
        await assertMetadata(cwd, args[0] === "init");
        const scope = ["--git-dir=" + join(cwd, ".git"), "--work-tree=" + cwd];
        // A repository can configure clean/process filters invoked by git add.
        // Read only their names, then override every driver before any operation.
        let filterOverrides: string[] = [];
        try {
            if (args[0] === "init") throw Object.assign(new Error("initializing"), { code: 1 });
            const listed = await execFileAsync("git", [...scope, "config", "--null", "--name-only", "--get-regexp", "^filter\\."],
                { cwd, timeout: 5_000, windowsHide: true, env: gitEnvironment(), maxBuffer: 100_000 });
            const drivers = new Set(listed.stdout.split("\0").filter(Boolean).map(key => key.slice(0, key.lastIndexOf("."))));
            filterOverrides = [...drivers].flatMap(driver => ["-c", driver + ".clean=", "-c", driver + ".smudge=", "-c", driver + ".process=", "-c", driver + ".required=false"]);
        } catch (error) {
            if ((error as { code?: number }).code !== 1) throw error;
        }
        const { stdout, stderr } = await execFileAsync("git", ["--no-pager", "--literal-pathspecs", ...scope,
            "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + nullPath,
            "-c", "core.attributesFile=" + nullPath, "-c", "commit.gpgSign=false",
            "-c", "log.showSignature=false", "-c", "submodule.recurse=false", "-c", "credential.helper=",
            "-c", "diff.external=", "-c", "protocol.allow=never", ...filterOverrides, ...args],
            { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: gitEnvironment() });
        return { stdout, stderr };
    } catch (error) {
        const err = error as { killed?: boolean; stderr?: string; message?: string };
        throw new GitError(err.killed ? "Tempo limite do Git excedido" : err.stderr?.trim() || err.message || "Falha ao executar Git");
    }
}
export async function assertGitRepo(cwd: string): Promise<void> {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], 5_000);
}
export function truncateOutput(text: string, max = 20_000) {
    return { text: text.slice(0, max), truncated: text.length > max };
}
export async function safeTrackedFiles(cwd: string, path?: string): Promise<string[]> {
    if (path) await resolveSafePath(cwd, path, { mustExist: false });
    const { stdout } = await runGit(cwd, ["ls-files", "-z", "--", path ?? "."]);
    const files: string[] = [];
    for (const file of stdout.split("\0").filter(Boolean)) {
        try { await resolveSafePath(cwd, file, { mustExist: false }); files.push(file); }
        catch (error) { if (!(error instanceof UnsafePathError)) throw error; }
    }
    if (files.length > 1000) throw new GitError("Informe um caminho mais específico (limite de 1000 arquivos).");
    return files;
}
