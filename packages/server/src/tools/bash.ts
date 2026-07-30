import { spawn } from "child_process";
import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT_SIZE = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const MAX_MEMORY_KB = 512 * 1024; 

const BLOCKED_COMMANDS = new Set([
    "rm",
    "sudo",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "mkfs",
    "curl",
    "wget",
    "ssh",
    "scp",
    "sftp",
    "dd",
    "kill",
    "killall",
    "pkill",
    "systemctl",
    "service",
    "chown",
    "chmod",
    "passwd",
    "userdel",
    "useradd",
    "visudo",
    "crontab",
    "nc",
    "netcat"
]);


const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
    npm: new Set(["publish"]),
    pnpm: new Set(["publish"]),
    yarn: new Set(["publish"]),
    bun: new Set(["publish"]),
    git: new Set(["push"])
};


const CHAIN_SPLIT_REGEX = /(?:&&|\|\||;|\||`|\$\()/;

export class CommandValidationError extends Error {}


function extractBaseCommand(segment: string): { command: string; args: string[] } | null {
    const tokens = segment.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
    if (!tokens || tokens.length === 0) return null;

    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
        i++;
    }
    const command = tokens[i];
    if (!command) return null;

    const base = command.split("/").pop() ?? command;
    return { command: base.replace(/^['"]|['"]$/g, ""), args: tokens.slice(i + 1) };
}


export function validateCommand(command: string): void {
    if (!command || !command.trim()) {
        throw new CommandValidationError("Comando vazio");
    }

    const segments = command
        .split(CHAIN_SPLIT_REGEX)
        .map((s) => s.trim())
        .filter(Boolean);

  
    const toCheck = segments.length > 0 ? segments : [command];

    for (const segment of toCheck) {
        const parsed = extractBaseCommand(segment);
        if (!parsed) continue;

        const { command: base, args } = parsed;

        if (BLOCKED_COMMANDS.has(base)) {
            throw new CommandValidationError(
                `Comando "${base}" não é permitido por motivos de segurança.`
            );
        }

        const blockedSubs = BLOCKED_SUBCOMMANDS[base];
        if (blockedSubs) {
            const subcommand = args.find((a) => !a.startsWith("-"));
            if (subcommand && blockedSubs.has(subcommand)) {
                throw new CommandValidationError(
                    `Comando "${base} ${subcommand}" não é permitido por motivos de segurança.`
                );
            }
        }
    }
}

function truncateStream(chunks: string[], totalLength: number, maxSize: number) {
    if (totalLength <= maxSize) {
        return { text: chunks.join(""), truncated: false };
    }
 
    return { text: chunks.join("").slice(0, maxSize), truncated: true };
}

type ExecResult = {
    stdout: string;
    stderr: string;
    truncated: boolean;
    exitCode: number;
    timedOut: boolean;
};


function runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal
): Promise<ExecResult> {
    return new Promise((resolvePromise) => {
     
        const wrappedCommand = `ulimit -v ${MAX_MEMORY_KB} 2>/dev/null; exec ${command}`;

        const child = spawn("/bin/sh", ["-c", wrappedCommand], {
            cwd,
  
            detached: true,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let settled = false;
        let timedOut = false;

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        let stdoutLen = 0;
        let stderrLen = 0;

        const killGroup = (sig: NodeJS.Signals) => {
            if (child.pid == null) return;
            try {
                process.kill(-child.pid, sig);
            } catch {
            }
        };

        const forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 5_000);
        forceKillTimer.unref();

        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
        }, timeoutMs);

        const onAbort = () => {
            killGroup("SIGTERM");
        };
        signal.addEventListener("abort", onAbort, { once: true });

        const finish = (exitCode: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            clearTimeout(forceKillTimer);
            signal.removeEventListener("abort", onAbort);

            const out = truncateStream(stdoutChunks, stdoutLen, MAX_OUTPUT_SIZE);
            const err = truncateStream(stderrChunks, stderrLen, MAX_OUTPUT_SIZE);

            resolvePromise({
                stdout: out.text,
                stderr: err.text,
                truncated: out.truncated || err.truncated,
                exitCode,
                timedOut
            });
        };

        child.stdout?.on("data", (chunk: Buffer) => {
            if (stdoutLen < MAX_OUTPUT_SIZE) {
                stdoutChunks.push(chunk.toString("utf-8"));
                stdoutLen += chunk.length;
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            if (stderrLen < MAX_OUTPUT_SIZE) {
                stderrChunks.push(chunk.toString("utf-8"));
                stderrLen += chunk.length;
            }
        });

        child.on("error", () => finish(1));
        child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    });
}

export function createBashTool(cwd: string) {
    return tool({
        description:
            "Executa um comando de shell dentro do diretório de trabalho do projeto. Comandos destrutivos, de rede externa ou de administração do sistema são bloqueados automaticamente.",
        inputSchema: z.object({
            command: z.string().describe("Comando de shell a ser executado"),
            timeoutMs: z
                .number()
                .int()
                .positive()
                .max(MAX_TIMEOUT_MS)
                .optional()
                .describe(`Timeout em milissegundos. Padrão: ${DEFAULT_TIMEOUT_MS}`)
        }),
        execute: async ({ command, timeoutMs }, { abortSignal }) => {
            try {
                validateCommand(command);
            } catch (e) {
                if (e instanceof CommandValidationError) {
                    return {
                        stdout: "",
                        stderr: e.message,
                        truncated: false,
                        exitCode: 126
                    };
                }
                throw e;
            }


            const controller = new AbortController();
            const forwardAbort = () => controller.abort();
            abortSignal?.addEventListener("abort", forwardAbort, { once: true });

            try {
                const result = await runCommand(
                    command,
                    cwd,
                    timeoutMs ?? DEFAULT_TIMEOUT_MS,
                    controller.signal
                );

                return {
                    stdout: result.stdout,
                    stderr: result.timedOut
                        ? `${result.stderr}\n[processo encerrado: tempo limite excedido]`.trim()
                        : result.stderr,
                    truncated: result.truncated,
                    exitCode: result.exitCode
                };
            } finally {
                abortSignal?.removeEventListener("abort", forwardAbort);
            }
        }
    });
}
