import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, lstat, copyFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isInside, isSensitivePath, resolveSafePath } from "../utils/path";

export type CommandResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean };
const OUTPUT_LIMIT = 20_000;

export async function snapshotWorkspace(cwd: string, destination: string, signal?: AbortSignal): Promise<void> {
    let bytes = 0, files = 0;
    const visit = async (source: string, target: string) => {
        signal?.throwIfAborted();
        await mkdir(target, { recursive: true, mode: 0o755 });
        await chmod(target, 0o755);
        for (const entry of await readdir(source, { withFileTypes: true })) {
            signal?.throwIfAborted();
            if (isSensitivePath(entry.name) || ["node_modules", "dist", ".dist", "coverage"].includes(entry.name)) continue;
            if (++files > 20_000) throw new Error("Workspace excede o limite de arquivos da sandbox.");
            if (entry.isSymbolicLink()) continue;
            const safe = await resolveSafePath(cwd, join(source, entry.name));
            const info = await lstat(safe);
            if (info.isDirectory()) await visit(safe, join(target, entry.name));
            else if (info.isFile()) {
                bytes += info.size;
                if (bytes > 200 * 1024 * 1024) throw new Error("Workspace excede 200 MB para a sandbox.");
                const copied = join(target, entry.name);
                await copyFile(safe, copied);
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
    timeoutMs: number; signal?: AbortSignal; onStop?: () => Promise<void>; env?: NodeJS.ProcessEnv;
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
    const image = process.env.MYAGENT_SANDBOX_IMAGE;
    if (!image) throw new Error("Shell bloqueado: configure MYAGENT_SANDBOX_IMAGE com uma imagem Docker local de confiança. Não há fallback para shell do host.");
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
