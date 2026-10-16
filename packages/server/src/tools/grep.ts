import { relative, join } from "node:path";
import { readdir, open, lstat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, isSensitivePath, UnsafePathError } from "../utils/path";
import { abortable, toolDeadline } from "../lib/tool-io";
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const MAX_MATCHES = 200;
export function createGrepTool(cwd: string, timeoutMs = 15_000) {
    return tool({
        description: "Busca texto ou regex em arquivos seguros; literal=true evita interpretar regex. Exclui links e credenciais. Até 200 resultados, 20 MB lidos e 15 segundos; regex executa em worker cancelável.",
        inputSchema: z.object({ pattern: z.string().min(1).max(1000), path: z.string().optional(), caseSensitive: z.boolean().optional(), literal: z.boolean().optional() }),
        execute: async ({ pattern, path, caseSensitive, literal }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal, timeoutMs);
            let worker: Worker | undefined;
            try {
            deadline.signal.throwIfAborted();
            const root = await resolveSafePath(cwd, path ?? ".");
            worker = new Worker(new URL("../lib/grep-worker.ts", import.meta.url).href);
            const matches: { file: string; line: number; text: string }[] = [];
            let visited = 0, limited = false, bytesRead = 0;
            const visit = async (file: string): Promise<void> => {
                deadline.signal.throwIfAborted();
                if (++visited > 20_000 || matches.length >= MAX_MATCHES) { limited = true; return; }
                let safe: string;
                try { safe = await resolveSafePath(cwd, file); }
                catch (error) { if (error instanceof UnsafePathError) return; throw error; }
                const info = await lstat(safe);
                if (info.isDirectory()) {
                    for (const entry of await readdir(safe, { withFileTypes: true })) {
                        if (entry.isSymbolicLink() || IGNORED.has(entry.name) || isSensitivePath(entry.name)) continue;
                        await visit(join(safe, entry.name));
                        if (limited) break;
                    }
                } else if (info.isFile() && info.size <= 1_000_000) {
                    const handle = await open(safe, "r");
                    let content: string;
                    try {
                        const buffer = Buffer.alloc(1_000_001);
                        let size = 0;
                        while (size < buffer.length) {
                            deadline.signal.throwIfAborted();
                            const read = await handle.read(buffer, size, Math.min(32_768, buffer.length - size), size);
                            if (!read.bytesRead) break;
                            size += read.bytesRead;
                            bytesRead += read.bytesRead;
                            if (bytesRead > 20_000_000) { limited = true; return; }
                        }
                        if (size > 1_000_000) { limited = true; return; }
                        content = buffer.subarray(0, size).toString("utf8");
                    } finally { await handle.close(); }
                    const response = await abortable(new Promise<{ matches?: { line: number; text: string }[]; error?: string }>((resolve, reject) => {
                        worker!.onmessage = event => resolve(event.data);
                        worker!.onerror = event => { event.preventDefault(); reject(new Error("Falha no worker de busca")); };
                        worker!.postMessage({ pattern, caseSensitive, literal, text: content, limit: MAX_MATCHES - matches.length });
                    }), deadline.signal);
                    if (response.error) throw new Error(response.error);
                    for (const match of response.matches ?? []) matches.push({ file: relative(cwd, safe).split("\\").join("/"), ...match });
                    if (matches.length >= MAX_MATCHES) limited = true;
                }
            };
            await visit(root);
            return { pattern, matches, truncated: limited };
            } finally { worker?.terminate(); deadline.dispose(); }
        },
    });
}
