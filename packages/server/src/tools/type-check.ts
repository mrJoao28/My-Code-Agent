import { tool } from "ai";
import { z } from "zod";
import { relative } from "node:path";
import { resolveSafePath } from "../utils/path";
import { runSandboxCommand } from "../security/sandbox";
export function parseTscOutput(output: string) {
    return output.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/);
        return match ? [{ file: match[1]!, line: Number(match[2]), column: Number(match[3]), severity: match[4]!, code: match[5]!, message: match[6]! }] : [];
    });
}
export function createTypeCheckTool(cwd: string) {
    return tool({
        description: "Verifica tipos com tsc na sandbox Docker, sem rede/credenciais e sem executar binários do host. Requer compilador e dependências na imagem configurada e aprovação.",
        inputSchema: z.object({ path: z.string().optional() }),
        execute: async ({ path }, { abortSignal }) => {
            const directory = await resolveSafePath(cwd, path ?? ".");
            await resolveSafePath(cwd, directory + "/tsconfig.json");
            const rel = relative(cwd, directory).split("\\").join("/");
            const quoted = "'" + ("/workspace/" + rel).replaceAll("'", "'\\''") + "'";
            const result = await runSandboxCommand(cwd, "cd " + quoted + " && tsc --noEmit --pretty false", 60_000, abortSignal);
            const diagnostics = parseTscOutput(result.stdout + "\n" + result.stderr);
            return { path: path ?? ".", ok: result.exitCode === 0 && !result.timedOut, timedOut: result.timedOut,
                errorCount: diagnostics.filter(d => d.severity === "error").length, warningCount: diagnostics.filter(d => d.severity === "warning").length,
                diagnostics, rawOutput: (result.stdout + result.stderr).slice(0, 15_000), truncated: result.truncated || result.stdout.length + result.stderr.length > 15_000 };
        },
    });
}
