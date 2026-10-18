import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SnapshotCache, boundedSetting } from "./snapshot";
export { snapshotWorkspace, SNAPSHOT_FILE_LIMIT } from "./snapshot";
const snapshots = new SnapshotCache();

export type CommandResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean };
const OUTPUT_LIMIT = 20_000;
export const DEFAULT_SANDBOX_IMAGE = "oven/bun:1.3.13";
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

export function dockerArguments(snapshot: string, name: string, image: string, command: string): string[] {
    if (!image || image.startsWith("-") || /[\s,]/.test(image)) throw new Error("Imagem de sandbox inválida.");
    if (snapshot.includes(",")) throw new Error("Diretório temporário não pode conter vírgulas.");
    return ["run", "--rm", "--pull=never", "--name", name, "--init", "--network=none",
        "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128",
        "--memory=512m", "--memory-swap=512m", "--cpus=1", "--no-healthcheck",
        "--user=65534:65534", "--tmpfs", `/tmp:rw,nosuid,nodev,size=${boundedSetting("MYAGENT_SANDBOX_TMPFS_MIB", 64, 4096)}m,mode=1777`,
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
export async function runSandboxCommand(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal, sessionId?: string): Promise<CommandResult> {
    if (!dockerAvailable) throw new Error("Docker indisponível: comandos desativados. Não há fallback para shell do host.");
    const image = sandboxImage();
    await ensureSandboxImage(image, signal);
    const cache = sessionId ? snapshots : new SnapshotCache();
    const lease = await cache.acquire(cwd, sessionId ?? randomUUID(), signal);
    const name = `myagent-${randomUUID()}`;
    try {
        return await runProcess("docker", dockerArguments(lease.directory, name, image, command), { timeoutMs, signal, onStop: () => removeContainer(name) });
    } finally {
        await removeContainer(name);
        lease.release();
        if (!sessionId) await cache.dispose();
    }
}
