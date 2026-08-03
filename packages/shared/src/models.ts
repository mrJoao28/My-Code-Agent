export type ModelPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export type SupportedProvider = "anthropic" | "openai" | "google" | "ollama";

export type SupportedChatModelDefinition = {
  id: string;
  provider: SupportedProvider;
  pricing: ModelPricing;
};

export const SUPPORTED_CHAT_MODELS = [
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 },
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    pricing: { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 },
  },
  {
    id: "gpt-5.4",
    provider: "openai",
    pricing: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 15 },
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    pricing: { inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 4.5 },
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    pricing: { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.25 },
  },
  {
    id: "llama3.1",
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "qwen2.5-coder",
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "deepseek-r1",
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "llama3.2:1b",
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "gemini-3-pro",
    provider: "google",
    pricing: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 12 },
  },
  {
    id: "gemini-3.6-flash",
    provider: "google",
    pricing: { inputUsdPerMillionTokens: 1.5, outputUsdPerMillionTokens: 7.5 },
  },
  {
    id: "gemini-3.5-flash-lite",
    provider: "google",
    pricing: { inputUsdPerMillionTokens: 0.3, outputUsdPerMillionTokens: 2.5 },
  },
] as const satisfies readonly SupportedChatModelDefinition[];

export type SupportedChatModel = SupportedChatModelDefinition;
export type SupportedChatModelId = string;

export function findSupportedChatModel(modelId: string): SupportedChatModel | undefined {
  return SUPPORTED_CHAT_MODELS.find((model) => model.id === modelId);
}

export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "claude-opus-4-6";
