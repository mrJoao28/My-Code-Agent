import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResolvedModel } from "./registry";

export const ANTHROPIC_PROVIDER_OPTIONS: Record<string, ProviderOptions> = {
  "claude-opus-4-6": {
    anthropic: {
      thinking: { type: "enabled", budgetTokens: 10000 },
    },
  },
  "claude-sonnet-4-6": {
    anthropic: {
      thinking: { type: "enabled", budgetTokens: 10000 },
    },
  },
};

export function resolveAnthropicModel(modelId: string, apiKey?: string): ResolvedModel {
  const provider = apiKey ? createAnthropic({ apiKey }) : anthropic;

  return {
    model: provider(modelId),
    provider: "anthropic",
    modelId,
    providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
  };
}
