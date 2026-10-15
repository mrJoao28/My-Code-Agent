// Escala visual de consumo acumulado; não representa o limite de contexto.
export const SESSION_TOKEN_SCALE = 1_000_000;

export function sumSessionTokens(messages: readonly { totalTokens?: number | null }[]): number {
    return messages.reduce((total, message) => total + (message.totalTokens ?? 0), 0);
}

export function formatTokens(tokens: number): string {
    if (tokens >= 999_950) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
    if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
    return String(tokens);
}
