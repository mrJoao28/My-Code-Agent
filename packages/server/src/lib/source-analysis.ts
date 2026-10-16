import { abortable } from "./tool-io";
export type SourceSymbol = { name: string; kind: string; line: number; endLine: number; exported: boolean };
type Analysis = { symbols: SourceSymbol[]; truncated: boolean };
export async function withSourceAnalyzer<T>(signal: AbortSignal, work: (analyze: (path: string, text: string, query?: string, caseSensitive?: boolean) => Promise<Analysis>) => Promise<T>) {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./source-worker.ts", import.meta.url).href);
    try {
        return await work(async (path, text, query, caseSensitive) => {
            signal.throwIfAborted();
            return abortable(new Promise<Analysis>((resolve, reject) => {
                worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
                worker.onerror = event => { event.preventDefault(); reject(new Error("SOURCE_PARSE_FAILED")); };
                worker.postMessage({ path, text, query, caseSensitive });
            }), signal);
        });
    } finally { worker.terminate(); }
}
