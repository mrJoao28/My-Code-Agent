import { google } from "@ai-sdk/google";
import type { SupportedChatModel } from "@myagent/shared";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResolvedModel } from "./registry";

export type GoogleModelId = Extract<SupportedChatModel, { provider: "google" }>["id"];

export const GOOGLE_PROVIDER_OPTIONS: Partial<Record<GoogleModelId, ProviderOptions>> = {
    "gemini-3-pro": {
        google: {
            thinkingConfig: {
                thinkingBudget: 8192
            }
        }
    }
};

export function resolveGoogleModel(modelId: GoogleModelId): ResolvedModel {
    return {
        model: google(modelId),
        provider: "google",
        modelId,
        providerOptions: GOOGLE_PROVIDER_OPTIONS[modelId]
    };
}