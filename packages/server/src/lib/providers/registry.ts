import type { SupportedProvider } from "@myagent/shared";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

export type ResolvedModel = {
  model: LanguageModel;
  provider: SupportedProvider;
  modelId: string;
  providerOptions?: ProviderOptions;
  toolOptions?: ProviderOptions;
  maxRetries?: number;
  abortSignal?: AbortSignal;
};

export function assertUnsupportedProvider(provider: never): never {
  throw new Error(`Unsupported provider: ${provider}`);
}
