import { findSupportedChatModel, type SupportedChatModel, type SupportedChatModelId } from "@myagent/shared";
import { resolveAnthropicModel } from "./anthropic";
import { resolveOpenAIModel } from "./openai";
import { resolveGoogleModel } from "./google";
import { resolveOllamaModel } from "./ollama";
import { assertUnsupportedProvider, type ResolvedModel } from "./registry";

export type { ResolvedModel } from "./registry";

function resolveSupportChatModel(model: SupportedChatModel): ResolvedModel {
    const provider = model.provider;

    switch (provider) {
        case "anthropic":
            return resolveAnthropicModel(model.id);
        case "openai":
            return resolveOpenAIModel(model.id);
        case "google":
            return resolveGoogleModel(model.id);
        case "ollama":
            return resolveOllamaModel(model.id);
        default:
            return assertUnsupportedProvider(provider);
    }
}

export function isSupportedChatModel(modelId: string): modelId is SupportedChatModelId {
    return findSupportedChatModel(modelId) !== undefined;
}

export function resolveChatModel(modelId: string): ResolvedModel {
    const model = findSupportedChatModel(modelId);
    if (!model) {
        throw new Error(`Unsupported models: ${modelId}`);
    }

    return resolveSupportChatModel(model);
}