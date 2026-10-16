/** Deadline liberável que acompanha o cancelamento da geração. */
export function toolDeadline(parent?: AbortSignal, timeoutMs = 15_000) {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("TOOL_TIMEOUT: tempo limite excedido")), timeoutMs);
    return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}

/** Lê e limita bytes antes de acumular, preservando UTF-8 fragmentado. */
export async function boundedResponseText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const decoder = new TextDecoder();
    let text = "", bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) return text + decoder.decode();
            bytes += value.byteLength;
            if (bytes > maxBytes) throw new Error("OUTPUT_LIMIT_REACHED: resposta excedeu o limite de bytes");
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason ?? new Error("Ação cancelada")); };
        const cleanup = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) abort();
    });
}
