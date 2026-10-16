// Executa somente o matcher confiável; padrões e arquivos são dados, não código.
const scope = globalThis as unknown as {
    onmessage: (event: { data: { pattern: string; caseSensitive?: boolean; literal?: boolean; text: string; limit: number } }) => void;
    postMessage: (data: unknown) => void;
};
scope.onmessage = ({ data }) => {
    try {
        const regex = data.literal ? null : new RegExp(data.pattern, data.caseSensitive ? "" : "i");
        const needle = data.caseSensitive ? data.pattern : data.pattern.toLowerCase();
        const matches: { line: number; text: string }[] = [];
        for (const [index, line] of data.text.split("\n").entries()) {
            const found = regex ? regex.test(line) : (data.caseSensitive ? line : line.toLowerCase()).includes(needle);
            if (found) matches.push({ line: index + 1, text: line.trim().slice(0, 300) });
            if (matches.length >= data.limit) break;
        }
        scope.postMessage({ matches });
    } catch { scope.postMessage({ error: "INVALID_PATTERN: expressão de busca inválida" }); }
};
export {};
