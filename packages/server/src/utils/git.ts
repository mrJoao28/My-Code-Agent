import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_SIZE = 20_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export class GitError extends Error {}

export async function assertGitRepo(cwd: string): Promise<void> {
    try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd,
            timeout: 5_000
        });
    } catch {
        throw new GitError(`"${cwd}" não é um repositório git (ou o git não está instalado)`);
    }
}

export async function runGit(
    cwd: string,
    args: string[],
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: MAX_BUFFER_BYTES
        });
        return { stdout, stderr };
    } catch (e: unknown) {
        const err = e as { killed?: boolean; stderr?: unknown; message?: string };
        if (err.killed) {
            throw new GitError(`Comando git demorou mais que ${timeoutMs}ms e foi encerrado`);
        }
        const stderr = typeof err.stderr === "string" ? err.stderr : String(err.message ?? e);
        throw new GitError(stderr.trim() || "Falha ao executar comando git");
    }
}

export function truncateOutput(text: string, max: number = MAX_OUTPUT_SIZE): { text: string; truncated: boolean } {
    if (text.length <= max) {
        return { text, truncated: false };
    }
    return { text: text.slice(0, max), truncated: true };
}