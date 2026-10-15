// A conexão pode fechar depois de texto parcial. Só response.completed confirma sucesso.
export function requireCompletedChatGPTStream(response: Response): Response {
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const safeMime = mime.length <= 100 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "não informado";
    const protocolError = () => new Error(`O ChatGPT retornou uma resposta fora do formato SSE (HTTP ${response.status}; Content-Type ${safeMime}). Tente novamente; se persistir, confira a conexão ou o proxy de rede.`);
    if (!response.body) throw protocolError();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    let format: "sse" | "json" | undefined;
    let jsonBody = "";
    let jsonBytes = 0;
    function failure(code: unknown): Error {
        const knownCode = typeof code === "string" ? code : "";
        if (["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable", "rate_limit_exceeded"].includes(knownCode)) {
            return new Error("O uso do plano ChatGPT está indisponível ou atingiu o limite. Confira as configurações de uso do ChatGPT.");
        }
        if (["invalid_token", "invalid_api_key", "token_expired", "authentication_error"].includes(knownCode)) {
            return new Error("A sessão ChatGPT não foi aceita. Conecte a conta novamente.");
        }
        if (["model_not_found", "permission_denied", "unsupported_model"].includes(knownCode)) {
            return new Error("A conta ChatGPT não tem acesso ao modelo solicitado. Atualize os modelos e selecione um disponível.");
        }
        return protocolError();
    }
    function line(value: string) {
        if (Buffer.byteLength(value) > 1_000_000) throw new Error("Evento ChatGPT excedeu o limite permitido.");
        if (!format && value.trim()) format = /^[\[{]/.test(value.trimStart()) ? "json" : "sse";
        if (format === "json") {
            jsonBytes += Buffer.byteLength(value) + 1;
            if (jsonBytes > 65_536) throw protocolError();
            jsonBody += value + "\n";
            return;
        }
        if (!value || value.startsWith(":")) return;
        if (!/^(?:data|event|id|retry)(?::|$)/.test(value)) throw protocolError();
        if (!value.startsWith("data:")) return;
        const data = value.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let event;
        try { event = JSON.parse(data); } catch { throw protocolError(); }
        if (!event || typeof event.type !== "string") throw protocolError();
        if (event.type === "response.completed") {
            if (event.response?.status !== "completed") throw new Error("A resposta ChatGPT não foi concluída.");
            completed = true;
        }
        if (event.type === "response.failed" || event.type === "error") {
            throw failure(event.response?.error?.code ?? event.error?.code ?? event.code);
        }
        if (event.type === "response.incomplete") throw new Error("A resposta ChatGPT foi interrompida por um limite.");
    }
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            if (chunk.byteLength > 1_000_000) throw new Error("Evento ChatGPT excedeu o limite permitido.");
            buffer += decoder.decode(chunk, { stream: true });
            if (!format && /^[\[{]/.test(buffer.trimStart())) format = "json";
            let end: number;
            while ((end = buffer.search(/[\r\n]/)) !== -1) { line(buffer.slice(0, end).trimEnd()); buffer = buffer.slice(end + 1); }
            if (Buffer.byteLength(buffer) > (format === "json" ? 65_536 : 1_000_000)) throw new Error("Evento ChatGPT excedeu o limite permitido.");
            if (format !== "json") controller.enqueue(chunk);
        },
        flush() {
            buffer += decoder.decode();
            if (buffer.trim()) line(buffer.trimEnd());
            if (format === "json") {
                let value;
                try { value = JSON.parse(jsonBody); } catch { throw protocolError(); }
                throw failure(value?.error?.code ?? value?.error?.type ?? value?.code);
            }
            if (!completed) throw new Error("A conexão ChatGPT terminou sem confirmar a conclusão da resposta.");
        },
    }));
    // Alguns gateways não preservam o MIME de SSE. Validamos os eventos, não apenas o cabeçalho.
    const headers = new Headers(response.headers); headers.delete("content-length");
    headers.set("content-type", "text/event-stream");
    return new Response(stream, { status: response.status, headers });
}
