import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

type CleanupDependencies = {
    remove: (path: string) => Promise<void>;
    collect: () => void;
    wait: (milliseconds: number) => Promise<void>;
    native?: (path: string) => Promise<boolean>;
};
export async function removeEvalRoot(root: string, dependencies: CleanupDependencies = {
    remove: (path: string) => rm(path, { recursive: true, force: true }),
    collect: () => { Bun.gc(true); },
    wait: (milliseconds: number) => Bun.sleep(milliseconds),
    native: async path => {
        const node = process.platform === "win32" ? Bun.which("node") : undefined;
        if (!node) return false;
        // Apenas limpeza de fixture própria já validada abaixo. Não executa
        // código do projeto: Node já é requisito do launcher e usa somente fs.
        const cleanupProcess = Bun.spawn([node, "-e", "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });", path], {
            stdin: "ignore", stdout: "ignore", stderr: "ignore",
            env: { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: tmpdir(), TMP: tmpdir() },
        });
        const timer = setTimeout(() => { cleanupProcess.kill(); }, 10_000);
        try { return await cleanupProcess.exited === 0; }
        finally { clearTimeout(timer); }
    },
}) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("myagent-eval-")) throw new Error("Diretório temporário inválido.");
    for (let attempt = 0; ; attempt++) {
        try { await dependencies.remove(target); return; }
        catch (error) {
            if (attempt >= 19 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            // Bun/Windows pode manter handles de subprocessos até a coleta.
            dependencies.collect();
            if (attempt === 0 && await dependencies.native?.(target)) return;
            await dependencies.wait(Math.min(100 * (attempt + 1), 1000));
        }
    }
}
