import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ResolvedModel } from "./registry";

export function resolveOllamaModel(modelId: string): ResolvedModel {
const ollamaProvider = createOpenAICompatible({
  name: "ollama",
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
});

  return {
    model: ollamaProvider.chatModel(modelId),
    provider: "ollama",
    modelId,
  };
}
