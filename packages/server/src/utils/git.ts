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
async function assertMetadata(cwd: string, initializing: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
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
            signal?.throwIfAborted();
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
export async function runGit(cwd: string, args: string[], timeoutMs = 15_000, signal?: AbortSignal, network = false): Promise<{ stdout: string; stderr: string }> {
    const nullPath = process.platform === "win32" ? "NUL" : "/dev/null";
    try {
        await assertMetadata(cwd, args[0] === "init", signal);
        const scope = ["--git-dir=" + join(cwd, ".git"), "--work-tree=" + cwd];
        // A repository can configure clean/process filters invoked by git add.
        // Read only their names, then override every driver before any operation.
        let filterOverrides: string[] = [];
        try {
            if (args[0] === "init") throw Object.assign(new Error("initializing"), { code: 1 });
            const listed = await execFileAsync("git", [...scope, "config", "--null", "--name-only", "--get-regexp", "^filter\\."],
                { cwd, timeout: 5_000, windowsHide: true, env: gitEnvironment(), maxBuffer: 100_000, signal });
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
            { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: network ? credentialEnvironment() : gitEnvironment(), signal });
        // Saídas de inspeção podem conter bytes de arquivos; só transporte recebe redação.
        return network ? { stdout: redactGitOutput(stdout), stderr: redactGitOutput(stderr) } : { stdout, stderr };
    } catch (error) {
        signal?.throwIfAborted();
        const err = error as { killed?: boolean; stderr?: string; message?: string };
        throw new GitError(err.killed ? "Tempo limite do Git excedido" : redactGitOutput(err.stderr?.trim() || err.message || "Falha ao executar Git"));
    }
}

export function redactGitOutput(text: string): string {
    return text.replace(/https?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, "https://[credenciais removidas]@")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[token removido]")
        .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, "$1[removido]")
        .replace(/((?:access_token|refresh_token|oauth_token|password|token)\s*[:=]\s*)[^\s&]+/gi, "$1[removido]");
}

export function redactGitArgs(value: unknown): unknown {
    if (typeof value === "string") return redactGitOutput(value);
    if (Array.isArray(value)) return value.map(redactGitArgs);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactGitArgs(item)]));
    return value;
}

function credentialEnvironment(): NodeJS.ProcessEnv {
    const env = gitEnvironment();
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"])
        if (process.env[name]) env[name] = process.env[name];
    // Nunca solicitar credenciais interativamente, inclusive pelo Git Credential Manager.
    env.GCM_INTERACTIVE = "Never";
    env.GIT_ASKPASS = process.platform === "win32" ? "NUL" : "/bin/false";
    return env;
}

async function externalConfig(scope: "--global" | "--system", key: "user.name" | "user.email" | "credential.helper", signal?: AbortSignal): Promise<string[]> {
    const env = credentialEnvironment();
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_NOSYSTEM;
    // Override só para fixtures; não há carregamento dessa configuração nas operações Git.
    if (process.env.GIT_CONFIG_GLOBAL) env.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
    try {
        const { stdout } = await execFileAsync("git", ["config", scope, "--no-includes", "--null", "--get-all", key],
            { env, timeout: 5_000, maxBuffer: 32_768, windowsHide: true, signal });
        const values = stdout.split("\0");
        if (values.at(-1) === "") values.pop();
        return values;
    } catch (error) {
        signal?.throwIfAborted();
        if ((error as { code?: number }).code === 1) return [];
        throw new GitError("Não foi possível consultar a configuração Git de identidade ou credenciais.");
    }
}

export async function commitIdentity(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const values: string[] = [];
    for (const key of ["user.name", "user.email"] as const) {
        let value = "";
        try { value = (await runGit(cwd, ["config", "--local", "--get", key], 5_000, signal)).stdout.trim(); } catch { signal?.throwIfAborted(); }
        if (!value) value = (await externalConfig("--global", key, signal)).at(-1)?.trim() ?? "";
        if (!value || value.length > 512 || /[\r\n\0]/.test(value))
            throw new GitError('Identidade Git ausente ou inválida. Configure git config --global user.name "Seu nome" e git config --global user.email "voce@exemplo.com".');
        values.push("-c", key + "=" + value);
    }
    return values;
}

export async function gitNetworkOptions(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const keys = (await runGit(cwd, ["config", "--local", "--null", "--name-only", "--list"], 5_000, signal)).stdout.split("\0");
    // Não permitir rewrites, headers, proxies ou comandos fornecidos pelo repositório.
    if (keys.some(key => /^(include\.|includeif\.|url\.|http\.|https\.|credential\.|core\.gitproxy$|remote\..*\.(proxy|uploadpack|receivepack|vcs)$)/i.test(key)))
        throw new GitError("Configuração de transporte local não permitida; remova rewrites, proxies, headers ou helpers locais antes de usar rede.");
    const helpers: string[] = [];
    for (const scope of ["--system", "--global"] as const) {
        for (const helper of await externalConfig(scope, "credential.helper", signal)) {
            if (!helper) helpers.length = 0;
            else helpers.push("-c", "credential.helper=" + helper);
        }
    }
    return ["-c", "protocol.https.allow=always", "-c", "http.sslVerify=true", "-c", "http.followRedirects=false", "-c", "http.proxy=", "-c", "credential.interactive=false", ...helpers];
}
export async function assertGitRepo(cwd: string, signal?: AbortSignal): Promise<void> {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], 5_000, signal);
}
export function truncateOutput(text: string, max = 20_000) {
    return { text: text.slice(0, max), truncated: text.length > max };
}
export async function safeTrackedFiles(cwd: string, path?: string, signal?: AbortSignal): Promise<string[]> {
    if (path) await resolveSafePath(cwd, path, { mustExist: false });
    const { stdout } = await runGit(cwd, ["ls-files", "-z", "--", path ?? "."], 15_000, signal);
    const files: string[] = [];
    for (const file of stdout.split("\0").filter(Boolean)) {
        signal?.throwIfAborted();
        try { await resolveSafePath(cwd, file, { mustExist: false }); files.push(file); }
        catch (error) { if (!(error instanceof UnsafePathError)) throw error; }
    }
    if (files.length > 1000) throw new GitError("Informe um caminho mais específico (limite de 1000 arquivos).");
    return files;
}
