import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ResolvedModel } from "./registry";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

const ollamaProvider = createOpenAICompatible({
  name: "ollama",
  baseURL: OLLAMA_BASE_URL,
  apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
});

export function resolveOllamaModel(modelId: string): ResolvedModel {
  return {
    model: ollamaProvider.chatModel(modelId),
    provider: "ollama",
    modelId,
  };
}
