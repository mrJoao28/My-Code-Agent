import { createOpenAI } from "@ai-sdk/openai";
import type { ResolvedModel } from "./registry";
import { chatGPT } from "../chatgpt";
import type { ChatGPTService } from "../chatgpt";
import { requireCompletedChatGPTStream } from "./chatgpt-stream";

const unsupported = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"];

export function resolveChatGPTModel(id: string, service: ChatGPTService = chatGPT, fetcher: typeof fetch = fetch): ResolvedModel {
    const clientId = service.activeId();
    if (!clientId || !service.models().some(model => model.id === id)) throw new Error("Conecte o ChatGPT e atualize os modelos disponíveis.");
    const connectionSignal = service.signal(clientId);
    const request: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== "https://api.openai.com/v1/responses" || init?.method !== "POST" || typeof init.body !== "string") {
            throw new Error("Requisição ChatGPT fora do endpoint autorizado.");
        }
        const signal = AbortSignal.any([connectionSignal, ...(init.signal ? [init.signal] : [])]);
        const token = await service.accessToken(clientId, signal);
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("Accept", "text/event-stream");
        const body = JSON.parse(init.body);
        for (const field of unsupported) delete body[field];
        body.store = false; body.stream = true;
        if (!Array.isArray(body.input) || body.input.some((item: { role?: string }) => item.role === "system")) throw new Error("Contexto ChatGPT inválido.");
        const response = await fetcher(input, { ...init, headers, body: JSON.stringify(body), signal, redirect: "error" });
        if (response.ok) return requireCompletedChatGPTStream(response);
        await response.body?.cancel();
        const message = response.status === 401 || response.status === 403
            ? "Conecte o ChatGPT novamente e confira o acesso ao modelo e ao plano."
            : response.status === 429 ? "Limite do plano ChatGPT atingido. Confira o uso nas configurações do ChatGPT."
                : "A requisição ao ChatGPT falhou. Tente novamente.";
        return Response.json({ error: { message, type: "chatgpt_request_error", code: String(response.status) } }, { status: response.status });
    }, { preconnect: fetcher.preconnect });
    return {
        model: createOpenAI({ apiKey: "oauth-managed", fetch: request }).responses(id.slice("chatgpt:".length)),
        provider: "chatgpt", modelId: id, maxRetries: 0, abortSignal: connectionSignal,
        providerOptions: { openai: { store: false, systemMessageMode: "developer" } },
        toolOptions: { openai: { namespace: { name: "myagent", description: "Ferramentas locais do My-Code-Agent, sujeitas a aprovações e sandbox." } } },
    };
}
