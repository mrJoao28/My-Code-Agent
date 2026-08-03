import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SUPPORTED_CHAT_MODELS,
  type SupportedProvider,
  type SupportedChatModelDefinition,
} from "@myagent/shared";

export type CustomModel = SupportedChatModelDefinition & { apiKeyEnv?: string };

const PROJECT_ROOT = join(import.meta.dir, "../../../../");
const CONFIG_PATH = join(PROJECT_ROOT, ".myagent", "models.json");
const CORRUPT_CONFIG_PATH = `${CONFIG_PATH}.corrupt`;

export function getModelApiKeyEnv(model: SupportedChatModelDefinition | CustomModel) {
  const custom = "apiKeyEnv" in model ? model.apiKeyEnv : undefined;
  if (custom) return custom;
  if (model.provider === "ollama") return undefined;

  const normalized = model.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `MYAGENT_${model.provider.toUpperCase()}_${normalized}_API_KEY`;
}

function ensureConfigDirectory() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function readCustomModels(): CustomModel[] {
  if (!existsSync(CONFIG_PATH)) return [];

  try {
    const raw = readFileSync(CONFIG_PATH, "utf8").trim();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Model registry must contain an array");
    return parsed.filter(isCustomModel);
  } catch {
    // Keep the application usable if a previous write was interrupted or the file was edited manually.
    try {
      renameSync(CONFIG_PATH, CORRUPT_CONFIG_PATH);
    } catch {
      // Ignore backup failures; the registry can still be recreated.
    }
    return [];
  }
}

function isCustomModel(value: unknown): value is CustomModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return typeof model.id === "string" &&
    ["anthropic", "openai", "google", "ollama"].includes(String(model.provider));
}

function writeCustomModels(models: CustomModel[]) {
  ensureConfigDirectory();
  const tempPath = `${CONFIG_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");
  renameSync(tempPath, CONFIG_PATH);
}

export function getCustomModels() { return readCustomModels(); }
export function getAllModels(): SupportedChatModelDefinition[] { return [...SUPPORTED_CHAT_MODELS, ...readCustomModels()]; }
export function findModel(modelId: string) { return getAllModels().find((model) => model.id === modelId); }
export function findCustomModel(modelId: string) { return readCustomModels().find((model) => model.id === modelId); }

export function isModelConfigured(modelId: string) {
  const model = findModel(modelId);
  if (!model || model.provider === "ollama") return true;
  const envKey = getModelApiKeyEnv(model);
  return Boolean(envKey && process.env[envKey]);
}

export function addCustomModel(input: { id: string; provider: SupportedProvider; apiKeyEnv?: string }): CustomModel {
  const id = input.id.trim();
  if (!id) throw new Error("Model name is required");
  if (findModel(id)) throw new Error(`Model already exists: ${id}`);

  const model: CustomModel = {
    id,
    provider: input.provider,
    pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
  };

  writeCustomModels([...readCustomModels(), model]);
  return model;
}
