import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { myagentHome } from "@myagent/shared/home";
import { chatGPT } from "./chatgpt";
import {
  SUPPORTED_CHAT_MODELS,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  validContextWindow,
  type SupportedProvider,
  type SupportedChatModelDefinition,
} from "@myagent/shared";

export type CustomModel = SupportedChatModelDefinition & {
  apiKeyEnv?: string;
};

const CONFIG_PATH = join(myagentHome(), "models.json");

export function getModelApiKeyEnv(model: Pick<SupportedChatModelDefinition, "id" | "provider"> & { apiKeyEnv?: string; pricing?: unknown }) {
  const custom = "apiKeyEnv" in model ? model.apiKeyEnv : undefined;
  if (custom) return custom;
  if (model.provider === "ollama" || model.provider === "chatgpt") return undefined;

  const normalized = model.id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `MYAGENT_${model.provider.toUpperCase()}_${normalized}_API_KEY`;
}

function ensureConfigDirectory() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

export function parseCustomModels(parsed: unknown): CustomModel[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((model): model is CustomModel => model && typeof model === "object"
    && typeof model.id === "string" && ["anthropic", "openai", "google", "ollama"].includes(model.provider)
    && (model.contextWindow === undefined || validContextWindow(model.contextWindow)))
    .map(model => ({ ...model, contextWindow: model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
      pricing: model.pricing ?? SUPPORTED_CHAT_MODELS.find(base => base.id === model.id)?.pricing
        ?? { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } }));
}

function readCustomModels(): CustomModel[] {
  if (!existsSync(CONFIG_PATH)) return [];

  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return parseCustomModels(parsed);
  } catch {
    return [];
  }
}

function writeCustomModels(models: CustomModel[]) {
  ensureConfigDirectory();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(models, null, 2)}\n`, "utf8");
}

export function getCustomModels(): CustomModel[] {
  return readCustomModels();
}

export function getAllModels(): SupportedChatModelDefinition[] {
  const custom = readCustomModels();
  const overrides = new Map(custom.map(model => [model.id, model]));
  return [...chatGPT.models(), ...SUPPORTED_CHAT_MODELS.map(model => overrides.get(model.id) ?? model),
    ...custom.filter(model => !SUPPORTED_CHAT_MODELS.some(base => base.id === model.id))];
}

export function findModel(modelId: string): SupportedChatModelDefinition | undefined {
  return getAllModels().find((model) => model.id === modelId);
}

export function findCustomModel(modelId: string): CustomModel | undefined {
  return readCustomModels().find((model) => model.id === modelId);
}

export function isModelConfigured(modelId: string) {
  const model = findModel(modelId);
  if (!model || model.provider === "ollama") return true;
  if (model.provider === "chatgpt") return chatGPT.status().connected;

  const envKey = getModelApiKeyEnv(model);
  return Boolean(envKey && process.env[envKey]);
}

export function addCustomModel(input: {
  id: string;
  provider: SupportedProvider;
  apiKeyEnv?: string;
  contextWindow?: number;
}): CustomModel {
  if (input.contextWindow !== undefined && !validContextWindow(input.contextWindow)) throw new Error("contextWindow inválido");
  const id = input.id.trim();

  if (!id) throw new Error("Model name is required");
  if (id.startsWith("chatgpt:")) throw new Error("Os modelos ChatGPT são descobertos ao conectar a conta.");
  if (findModel(id)) throw new Error(`Model already exists: ${id}`);

  const model: CustomModel = {
    id,
    provider: input.provider,
    contextWindow: input.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    pricing: {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
  };

  const models = readCustomModels();
  models.push(model);
  writeCustomModels(models);
  return model;
}
