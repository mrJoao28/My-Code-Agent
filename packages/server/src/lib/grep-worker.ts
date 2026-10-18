export type GrepLine = { line: number; text: string };
export type GrepWorkerMatch = GrepLine & { before?: GrepLine[]; after?: GrepLine[] };
export type GrepWorkerResponse = { matches?: GrepWorkerMatch[]; error?: string; truncated?: boolean };

// Executa somente o matcher confiável; padrões e arquivos são dados, não código.
const scope = globalThis as unknown as {
    onmessage: (event: { data: { pattern: string; caseSensitive?: boolean; literal?: boolean; text: string; limit: number; context?: number; maxChars?: number } }) => void;
    postMessage: (data: unknown) => void;
};
scope.onmessage = ({ data }) => {
    try {
        const regex = data.literal ? null : new RegExp(data.pattern, data.caseSensitive ? "" : "i");
        const needle = data.caseSensitive ? data.pattern : data.pattern.toLowerCase();
        const matches: GrepWorkerMatch[] = [], lines = data.text.split(/\r?\n/);
        const context = data.context ?? 0;
        let chars = 0, truncated = false;
        const contextLine = (index: number): GrepLine => ({ line: index + 1, text: lines[index]!.slice(0, 300) });
        for (const [index, line] of lines.entries()) {
            const found = regex ? regex.test(line) : (data.caseSensitive ? line : line.toLowerCase()).includes(needle);
            if (found) {
                const match: GrepWorkerMatch = { line: index + 1, text: line.trim().slice(0, 300) };
                if (context) {
                    match.before = Array.from({ length: Math.min(index, context) }, (_, i) => contextLine(Math.max(0, index - context) + i));
                    match.after = Array.from({ length: Math.min(lines.length - index - 1, context) }, (_, i) => contextLine(index + i + 1));
                }
                const cost = JSON.stringify(match).length;
                if (chars + cost > (data.maxChars ?? 60_000)) { truncated = true; break; }
                chars += cost; matches.push(match);
            }
            if (matches.length >= data.limit) break;
        }
        scope.postMessage({ matches, truncated });
    } catch { scope.postMessage({ error: "INVALID_PATTERN: expressão de busca inválida" }); }
};
export {};
