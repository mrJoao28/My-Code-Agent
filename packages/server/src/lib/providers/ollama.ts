import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { SupportedChatModel } from "@myagent/shared";
import type { ResolvedModel } from "./registry";

export type OllamaModelId = Extract<SupportedChatModel, { provider: "ollama" }>["id"];


const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

const ollamaProvider = createOpenAICompatible({
    name: "ollama",
    baseURL: OLLAMA_BASE_URL,

    apiKey: process.env.OLLAMA_API_KEY ?? "ollama"
});

export function resolveOllamaModel(modelId: OllamaModelId): ResolvedModel {
    return {
        model: ollamaProvider.chatModel(modelId),
        provider: "ollama",
        modelId
    };
}