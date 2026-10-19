import { z } from "zod";
import { DEFAULT_MODEL_CONTEXT_WINDOW, SUPPORTED_CHAT_MODELS, validContextWindow } from "@myagent/shared";
import { readPrivateConfig, writePrivateConfig } from "./private-config";

export class ModelConfigError extends Error {}

export const apiKeyEnvSchema = z.string().max(200).regex(/^[A-Z_][A-Z0-9_]*$/).refine(key =>
    !/^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|NODE_.+|BUN_.+|LD_.+|DYLD_.+|MYAGENT_(HOME|CONFIG_DIR|WORKSPACE_ROOTS|API_TOKEN|SANDBOX_IMAGE|ENABLE_CHATGPT))$/.test(key));
const schema = z.array(z.object({
    id: z.string().trim().min(1).max(200).refine(id => !id.startsWith("chatgpt:")),
    provider: z.enum(["anthropic", "openai", "google", "ollama"]),
    displayName: z.string().min(1).max(200).optional(),
    apiKeyEnv: apiKeyEnvSchema.optional(),
    contextWindow: z.number().refine(validContextWindow).optional(),
    pricing: z.object({ inputUsdPerMillionTokens: z.number().finite().nonnegative(), outputUsdPerMillionTokens: z.number().finite().nonnegative() }).optional(),
}).strict()).max(1000).refine(models => new Set(models.map(model => model.id)).size === models.length);
export function parseCustomModels(value: unknown) {
    const result = schema.safeParse(value);
    if (!result.success) throw new ModelConfigError("models.json inválido: confira a lista de modelos, providers, apiKeyEnv, preços e contextWindow. O arquivo foi preservado.");
    return result.data.map(model => ({ ...model, contextWindow: model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW, pricing: model.pricing ?? SUPPORTED_CHAT_MODELS.find(base => base.id === model.id)?.pricing ?? { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } }));
}
export function readModelConfigEntries(path: string) {
    const text = readPrivateConfig(path);
    if (text === undefined) return [];
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ModelConfigError("models.json corrompido: JSON inválido. Corrija o arquivo; ele não foi sobrescrito."); }
    // Valida também os campos não relacionados à janela, sem transformar a
    // ausência de contextWindow em um override explícito de 16k.
    parseCustomModels(value);
    return schema.parse(value);
}
export function readModelConfig(path: string) {
    return parseCustomModels(readModelConfigEntries(path));
}
export function writeModelConfig(path: string, models: unknown) {
    writePrivateConfig(path, JSON.stringify(parseCustomModels(models), null, 2) + "\n");
}
