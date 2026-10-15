export async function boundedJSON(response: Response, maxBytes = 1_000_000): Promise<unknown> {
    if (!response.body) throw new Error("Resposta vazia.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error("Resposta excedeu o limite permitido.");
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder().decode(bytes));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
