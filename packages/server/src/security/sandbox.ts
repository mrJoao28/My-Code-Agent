import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, opendir, lstat, open, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isInside, isSensitivePath, resolveSafePath } from "../utils/path";

export type CommandResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean };
const OUTPUT_LIMIT = 20_000;
export const DEFAULT_SANDBOX_IMAGE = "oven/bun:1.3.13";
export const SNAPSHOT_FILE_LIMIT = 5 * 1024 * 1024;
let dockerAvailable = false;
export function setDockerAvailable(available: boolean) { dockerAvailable = available; }
export function isDockerAvailable() { return dockerAvailable; }
export function sandboxImage() {
    const image = process.env.MYAGENT_SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE;
    if (!image || image.startsWith("-") || /[\s,]/.test(image)) throw new Error("Imagem de sandbox inválida.");
    return image;
}
export async function checkDocker(signal?: AbortSignal, run = runProcess): Promise<boolean> {
    try {
        const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 3_000, signal });
        signal?.throwIfAborted();
        return result.exitCode === 0 && !result.timedOut;
    } catch (error) { signal?.throwIfAborted(); return false; }
}
export async function imagePresent(image = sandboxImage(), signal?: AbortSignal, run = runProcess) {
    const result = await run("docker", ["image", "inspect", image], { timeoutMs: 3_000, signal });
    signal?.throwIfAborted();
    return result.exitCode === 0 && !result.timedOut;
}
export async function ensureSandboxImage(image: string, signal?: AbortSignal, run = runProcess, progress = (message: string) => process.stderr.write(message)) {
    if (await imagePresent(image, signal, run)) return;
    progress(`Preparando sandbox Docker: baixando ${image}...\n`);
    const result = await run("docker", ["pull", image], { timeoutMs: 180_000, signal,
        onOutput: chunk => progress(chunk.slice(0, 2_000)),
    });
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut) throw new Error("Não foi possível baixar a imagem da sandbox. Confira a conexão de rede e o nome da imagem; não há execução no host.");
}

export async function snapshotWorkspace(cwd: string, destination: string, signal?: AbortSignal): Promise<void> {
    let bytes = 0, files = 0;
    const visit = async (source: string, target: string) => {
        signal?.throwIfAborted();
        await mkdir(target, { recursive: true, mode: 0o755 });
        await chmod(target, 0o755);
        for await (const entry of await opendir(source)) {
            signal?.throwIfAborted();
            if (isSensitivePath(entry.name) || ["node_modules", "dist", ".dist", "build", "out", "target", ".next", ".nuxt", ".cache", ".turbo", "coverage"].includes(entry.name)) continue;
            if (++files > 20_000) throw new Error("Workspace excede o limite de arquivos da sandbox.");
            if (entry.isSymbolicLink()) continue;
            const safe = await resolveSafePath(cwd, join(source, entry.name));
            const info = await lstat(safe);
            if (info.isDirectory()) await visit(safe, join(target, entry.name));
            else if (info.isFile()) {
                if (info.size > SNAPSHOT_FILE_LIMIT) continue;
                const copied = join(target, entry.name);
                const input = await open(safe, "r");
                let output: Awaited<ReturnType<typeof open>> | undefined;
                try {
                    output = await open(copied, "wx", 0o600);
                    const buffer = Buffer.alloc(64 * 1024);
                    let fileBytes = 0;
                    for (;;) {
                        signal?.throwIfAborted();
                        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
                        if (!bytesRead) break;
                        bytes += bytesRead; fileBytes += bytesRead;
                        if (bytes > 200 * 1024 * 1024 || fileBytes > SNAPSHOT_FILE_LIMIT) throw new Error("Snapshot excede os limites de leitura da sandbox.");
                        let written = 0;
                        while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
                    }
                } finally { await input.close(); await output?.close(); }
                await chmod(copied, info.mode & 0o111 ? 0o755 : 0o644);
            }
        }
    };
    if (isInside(resolve(cwd), resolve(destination))) throw new Error("Snapshot deve ficar fora do workspace.");
    await visit(cwd, destination);
}

export function dockerArguments(snapshot: string, name: string, image: string, command: string): string[] {
    if (!image || image.startsWith("-") || /[\s,]/.test(image)) throw new Error("Imagem de sandbox inválida.");
    if (snapshot.includes(",")) throw new Error("Diretório temporário não pode conter vírgulas.");
    return ["run", "--rm", "--pull=never", "--name", name, "--init", "--network=none",
        "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128",
        "--memory=512m", "--memory-swap=512m", "--cpus=1", "--no-healthcheck",
        "--user=65534:65534", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
        "--mount", `type=bind,source=${snapshot},target=/workspace,readonly`, "--workdir=/workspace",
        "--entrypoint=/bin/sh", image, "-c", command];
}

export async function runProcess(executable: string, args: string[], options: {
    timeoutMs: number; signal?: AbortSignal; onStop?: () => Promise<void>; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void;
}): Promise<CommandResult> {
    options.signal?.throwIfAborted();
    return new Promise((resolveResult, reject) => {
        const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: options.env });
        let stdout = "", stderr = "", truncated = false, timedOut = false;
        let stopped: Promise<void> | undefined;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
            if (stopped) return;
            child.kill("SIGTERM");
            forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
            stopped = options.onStop?.().catch(() => {}) ?? Promise.resolve();
        };
        const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
        const onAbort = () => stop();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) stop();
        const append = (chunk: Buffer, current: string) => {
            options.onOutput?.(chunk.toString("utf8").slice(0, OUTPUT_LIMIT));
            const next = current + chunk.toString("utf8");
            if (next.length > OUTPUT_LIMIT) truncated = true;
            return next.slice(0, OUTPUT_LIMIT);
        };
        child.stdout?.on("data", (chunk: Buffer) => { stdout = append(chunk, stdout); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr = append(chunk, stderr); });
        const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); options.signal?.removeEventListener("abort", onAbort); };
        child.once("error", error => { cleanup(); reject(error); });
        child.once("close", async code => {
            cleanup(); await stopped;
            resolveResult({ stdout, stderr, truncated, timedOut, exitCode: timedOut ? 124 : code ?? 1 });
        });
    });
}
function removeContainer(name: string): Promise<void> {
    return new Promise(done => { execFile("docker", ["rm", "--force", name], { timeout: 10_000, windowsHide: true }, () => done()); });
}
export async function runSandboxCommand(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    if (!dockerAvailable) throw new Error("Docker indisponível: comandos desativados. Não há fallback para shell do host.");
    const image = sandboxImage();
    await ensureSandboxImage(image, signal);
    const directory = await mkdtemp(join(tmpdir(), "myagent-sandbox-"));
    const name = `myagent-${randomUUID()}`;
    try {
        await snapshotWorkspace(cwd, directory, signal);
        return await runProcess("docker", dockerArguments(directory, name, image, command), { timeoutMs, signal, onStop: () => removeContainer(name) });
    } finally {
        await removeContainer(name);
        await rm(directory, { recursive: true, force: true });
    }
}
