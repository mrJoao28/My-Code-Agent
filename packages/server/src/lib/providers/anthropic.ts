import { anthropic } from "@ai-sdk/anthropic";
import type { SupportedChatModel } from "@myagent/shared";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResolvedModel } from "./registry";

export type AnthropicModelId = Extract<SupportedChatModel, { provider: "anthropic" }>["id"];

export const ANTHROPIC_PROVIDER_OPTIONS: Partial<Record<AnthropicModelId, ProviderOptions>> = {
    "claude-opus-4-6": {
        anthropic: {
            thinking: {
                type: "enabled",
                budgetTokens: 10000
            }
        }
    },
    "claude-sonnet-4-6": {
        anthropic: {
            thinking: {
                type: "enabled",
                budgetTokens: 10000
            }
        }
    }
};

export function resolveAnthropicModel(modelId: AnthropicModelId): ResolvedModel {
    return {
        model: anthropic(modelId),
        provider: "anthropic",
        modelId,
        providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId]
    };
}
