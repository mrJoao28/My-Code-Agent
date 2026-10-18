import { relative, join } from "node:path";
import { readdir, open, lstat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath, isSensitivePath, UnsafePathError } from "../utils/path";
import { abortable, toolDeadline } from "../lib/tool-io";
import { loadSearchIgnore } from "../lib/search-ignore";
import type { GrepWorkerMatch, GrepWorkerResponse } from "../lib/grep-worker";
const MAX_MATCHES = 200;
const MAX_OUTPUT_CHARS = 60_000;
declare const MYAGENT_BUNDLED: boolean;
export function createGrepTool(cwd: string, timeoutMs = 15_000) {
    return tool({
        description: "Busca texto ou regex em arquivos seguros; literal=true evita regex. include é um glob relativo a path (sem barra, filtra nomes em qualquer nível). context retorna até 20 linhas antes/depois em before/after; trechos têm até 300 caracteres por linha. files_only=true retorna apenas nomes únicos em files, sem trechos. Respeita o .gitignore da raiz e as pastas fixas ignoradas; exclui links e credenciais. Até 200 resultados, 60 mil caracteres de saída, 20 MB lidos e 15 segundos; regex executa em worker cancelável.",
        inputSchema: z.object({ pattern: z.string().min(1).max(1000), path: z.string().optional(), caseSensitive: z.boolean().optional(), literal: z.boolean().optional(),
            include: z.string().min(1).max(1000).optional().describe("Glob de arquivos a pesquisar, relativo a path; ex.: **/*.ts ou *.ts"),
            context: z.number().int().min(0).max(20).optional().describe("Linhas anteriores e posteriores a cada ocorrência. Padrão: 0"),
            files_only: z.boolean().optional().describe("Retorna nomes únicos em files, sem linhas nem contexto. Padrão: false") }),
        execute: async ({ pattern, path, caseSensitive, literal, include, context, files_only }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal, timeoutMs);
            let worker: Worker | undefined;
            try {
            deadline.signal.throwIfAborted();
            const root = await resolveSafePath(cwd, path ?? ".");
            const ignored = await loadSearchIgnore(cwd, deadline.signal);
            const includeMatcher = include ? new Bun.Glob(include) : undefined;
            worker = new Worker(new URL(typeof MYAGENT_BUNDLED !== "undefined" && MYAGENT_BUNDLED ? "./grep-worker.js" : "../lib/grep-worker.ts", import.meta.url).href);
            const matches: ({ file: string } & GrepWorkerMatch)[] = [], files: string[] = [];
            let visited = 0, limited = false, bytesRead = 0, outputChars = 0;
            const resultCount = () => files_only ? files.length : matches.length;
            const visit = async (file: string): Promise<void> => {
                deadline.signal.throwIfAborted();
                if (++visited > 20_000 || resultCount() >= MAX_MATCHES) { limited = true; return; }
                let safe: string;
                try { safe = await resolveSafePath(cwd, file); }
                catch (error) { if (error instanceof UnsafePathError) return; throw error; }
                const info = await lstat(safe);
                if (ignored(safe, info.isDirectory())) return;
                if (info.isDirectory()) {
                    for (const entry of await readdir(safe, { withFileTypes: true })) {
                        if (entry.isSymbolicLink() || isSensitivePath(entry.name)) continue;
                        await visit(join(safe, entry.name));
                        if (limited) break;
                    }
                } else if (info.isFile() && info.size <= 1_000_000) {
                    const searchPath = relative(root, safe).replaceAll("\\", "/") || safe.split(/[\\/]/).at(-1)!;
                    if (includeMatcher && !includeMatcher.match(include!.includes("/") ? searchPath : searchPath.split("/").at(-1)!)) return;
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
                    const response = await abortable(new Promise<GrepWorkerResponse>((resolve, reject) => {
                        worker!.onmessage = event => resolve(event.data);
                        worker!.onerror = event => { event.preventDefault(); reject(new Error("Falha no worker de busca")); };
                        worker!.postMessage({ pattern, caseSensitive, literal, text: content, limit: files_only ? 1 : MAX_MATCHES - matches.length,
                            context: files_only ? 0 : context ?? 0, maxChars: MAX_OUTPUT_CHARS - outputChars });
                    }), deadline.signal);
                    if (response.error) throw new Error(response.error);
                    const file = relative(cwd, safe).replaceAll("\\", "/");
                    if (files_only && response.matches?.length) {
                        const cost = JSON.stringify(file).length;
                        if (outputChars + cost > MAX_OUTPUT_CHARS) limited = true;
                        else { files.push(file); outputChars += cost; }
                    } else if (!files_only) for (const match of response.matches ?? []) {
                        const entry = { file, ...match }, cost = JSON.stringify(entry).length;
                        if (outputChars + cost > MAX_OUTPUT_CHARS) { limited = true; break; }
                        matches.push(entry); outputChars += cost;
                    }
                    limited ||= response.truncated ?? false;
                    if (resultCount() >= MAX_MATCHES) limited = true;
                }
            };
            await visit(root);
            return { pattern, matches, files: files_only ? files : undefined, truncated: limited };
            } finally { worker?.terminate(); deadline.dispose(); }
        },
    });
}
