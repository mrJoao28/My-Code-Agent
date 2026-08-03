import { openai } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResolvedModel } from "./registry";

export const OPENAI_PROVIDER_OPTIONS: Record<string, ProviderOptions> = {
  "gpt-5.4": {
    openai: { reasoningSummary: "detailed" },
  },
};

export function resolveOpenAIModel(modelId: string, apiKey?: string): ResolvedModel {
  const provider = apiKey ? openai({ apiKey }) : openai;

  return {
    model: provider(modelId),
    provider: "openai",
    modelId,
    providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
  };
}
