import type { SupportedChatModelId, SupportedProvider } from "@myagent/shared";
import { findModel, findCustomModel } from "../model-registry";
import { resolveAnthropicModel } from "./anthropic";
import { resolveOpenAIModel } from "./openai";
import { resolveGoogleModel } from "./google";
import { resolveOllamaModel } from "./ollama";
import { assertUnsupportedProvider, type ResolvedModel } from "./registry";

export type { ResolvedModel } from "./registry";

function resolveSupportedModel(
  provider: SupportedProvider,
  modelId: string,
  apiKey?: string,
): ResolvedModel {
  switch (provider) {
    case "anthropic":
      return resolveAnthropicModel(modelId, apiKey);
    case "openai":
      return resolveOpenAIModel(modelId, apiKey);
    case "google":
      return resolveGoogleModel(modelId, apiKey);
    case "ollama":
      return resolveOllamaModel(modelId);
    default:
      return assertUnsupportedProvider(provider);
  }
}

export function isSupportedChatModel(modelId: string): modelId is SupportedChatModelId {
  return findModel(modelId) !== undefined;
}

export function resolveChatModel(modelId: string): ResolvedModel {
  const model = findModel(modelId);
  if (!model) {
    throw new Error(`Unsupported model: ${modelId}`);
  }

  const customModel = findCustomModel(modelId);
  const apiKey = customModel?.apiKeyEnv
    ? process.env[customModel.apiKeyEnv]
    : undefined;

  if (model.provider !== "ollama" && customModel && !apiKey) {
    throw new Error(`Missing API token for model: ${modelId}`);
  }

  return resolveSupportedModel(model.provider, model.id, apiKey);
}
