import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SUPPORTED_CHAT_MODELS,
  type SupportedProvider,
  type SupportedChatModelDefinition,
} from "@myagent/shared";

export type CustomModel = SupportedChatModelDefinition & {
  apiKeyEnv?: string;
};

const CONFIG_PATH = join(process.cwd(), ".myagent", "models.json");

export function getModelApiKeyEnv(model: SupportedChatModelDefinition | CustomModel) {
  const custom = "apiKeyEnv" in model ? model.apiKeyEnv : undefined;
  if (custom) return custom;
  if (model.provider === "ollama") return undefined;

  const normalized = model.id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `MYAGENT_${model.provider.toUpperCase()}_${normalized}_API_KEY`;
}

function ensureConfigDirectory() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function readCustomModels(): CustomModel[] {
  if (!existsSync(CONFIG_PATH)) return [];

  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
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
  return [...SUPPORTED_CHAT_MODELS, ...readCustomModels()];
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

  const envKey = getModelApiKeyEnv(model);
  return Boolean(envKey && process.env[envKey]);
}

export function addCustomModel(input: {
  id: string;
  provider: SupportedProvider;
  apiKeyEnv?: string;
}): CustomModel {
  const id = input.id.trim();

  if (!id) throw new Error("Model name is required");
  if (findModel(id)) throw new Error(`Model already exists: ${id}`);

  const model: CustomModel = {
    id,
    provider: input.provider,
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
