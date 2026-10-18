export const DEFAULT_MODEL_CONTEXT_WINDOW = 16_384;

export function validContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1_024 && value <= 2_147_483_647;
}

export type ModelPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export type SupportedProvider = "anthropic" | "openai" | "google" | "ollama" | "chatgpt";

export type SupportedChatModelDefinition = {
  id: string;
  provider: SupportedProvider;
  displayName?: string;
  pricing: ModelPricing;
  contextWindow: number;
};

export const SUPPORTED_CHAT_MODELS = [
  {
    id: "claude-sonnet-4-6",
    contextWindow: 1_000_000,
    provider: "anthropic",
    pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
  },
  {
    id: "claude-haiku-4-5",
    contextWindow: 200_000,
    provider: "anthropic",
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 },
  },
  {
    id: "claude-opus-4-6",
    contextWindow: 1_000_000,
    provider: "anthropic",
    pricing: { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 },
  },
  {
    id: "gpt-5.4",
    contextWindow: 1_050_000,
    provider: "openai",
    pricing: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 15 },
  },
  {
    id: "gpt-5.4-mini",
    contextWindow: 400_000,
    provider: "openai",
    pricing: { inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 4.5 },
  },
  {
    id: "gpt-5.4-nano",
    contextWindow: 400_000,
    provider: "openai",
    pricing: { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.25 },
  },
  {
    id: "llama3.1",
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "qwen2.5-coder",
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "deepseek-r1",
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "llama3.2:1b",
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    provider: "ollama",
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  },
  {
    id: "gemini-3-pro",
    contextWindow: 1_048_576,
    provider: "google",
    pricing: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 12 },
  },
  {
    id: "gemini-3.6-flash",
    contextWindow: 1_048_576,
    provider: "google",
    pricing: { inputUsdPerMillionTokens: 1.5, outputUsdPerMillionTokens: 7.5 },
  },
  {
    id: "gemini-3.5-flash-lite",
    contextWindow: 1_048_576,
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
