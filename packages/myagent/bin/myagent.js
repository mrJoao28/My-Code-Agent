#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const missingBun = "My-Code-Agent requer Bun >= 1.3.13 no PATH. Instale em https://bun.sh e abra um novo terminal. Depois execute myagent novamente.";
let runtime;
for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory.replace(/^"(.*)"$/, "$1"), process.platform === "win32" ? "bun.exe" : "bun");
    try {
        accessSync(candidate, fsConstants.X_OK);
        if (statSync(candidate).isFile()) { runtime = candidate; break; }
    } catch { /* Continue procurando apenas nos diretórios do PATH. */ }
}
if (!runtime) { console.error(missingBun); process.exit(1); }
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const child = spawn(runtime, [cli, ...process.argv.slice(2)], { stdio: "inherit", shell: false });
const forward = signal => { if (!child.killed) child.kill(signal); };
const interrupt = () => forward("SIGINT");
const terminate = () => forward("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
const cleanup = () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
};
child.once("error", error => {
    cleanup();
    console.error(error.code === "ENOENT"
        ? missingBun
        : `Não foi possível executar Bun (${error.code ?? "erro desconhecido"}). Confira a instalação e as permissões; veja https://bun.sh.`);
    process.exitCode = 1;
});
child.once("exit", (code, signal) => {
    cleanup();
    process.exitCode = code ?? (128 + (constants.signals[signal] ?? 1));
});
