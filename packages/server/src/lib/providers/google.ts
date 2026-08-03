import { google } from "@ai-sdk/google";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResolvedModel } from "./registry";

export const GOOGLE_PROVIDER_OPTIONS: Record<string, ProviderOptions> = {
  "gemini-3-pro": {
    google: {
      thinkingConfig: { thinkingBudget: 8192 },
    },
  },
};

export function resolveGoogleModel(modelId: string, apiKey?: string): ResolvedModel {
  const provider = apiKey ? google({ apiKey }) : google;

  return {
    model: provider(modelId),
    provider: "google",
    modelId,
    providerOptions: GOOGLE_PROVIDER_OPTIONS[modelId],
  };
}
