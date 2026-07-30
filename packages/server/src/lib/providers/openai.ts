import { openai } from "@ai-sdk/openai";
import type { SupportedChatModel } from "@myagent/shared";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResolvedModel } from "./registry";

export type OpenAIModelId = Extract<SupportedChatModel, { provider: "openai" }>["id"];

export const OPENAI_PROVIDER_OPTIONS: Partial<Record<OpenAIModelId, ProviderOptions>> = {
    "gpt-5.4": {
        openai: {
            reasoningSummary: "detailed"
        }
    }
};

export function resolveOpenAIModel(modelId: OpenAIModelId): ResolvedModel {
    return {
        model: openai(modelId),
        provider: "openai",
        modelId,
        providerOptions: OPENAI_PROVIDER_OPTIONS[modelId]
    };
}
