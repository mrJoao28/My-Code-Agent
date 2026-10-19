import { join } from "node:path";
import { z } from "zod";
import { myagentHome } from "@myagent/shared/home";
import { DEFAULT_CLOUD_CONTEXT_WINDOW, DEFAULT_MODEL_CONTEXT_WINDOW, SUPPORTED_CHAT_MODELS, validContextWindow, type ContextWindowResolution, type SupportedProvider } from "@myagent/shared";
import { readPrivateConfig, writePrivateConfig } from "./private-config";
import { readModelConfigEntries, ModelConfigError } from "./model-config";

const windowSchema = z.number().refine(validContextWindow, "contextWindow deve ser um inteiro entre 1024 e 2147483647");
const preferencesSchema = z.object({
    contextWindows: z.record(z.string().min(1).max(200), windowSchema).default({}),
    defaultLocalContextWindow: windowSchema.default(DEFAULT_MODEL_CONTEXT_WINDOW),
}).strict();
export function readModelPreferences(path = join(myagentHome(), "model-preferences.json")) {
    const text = readPrivateConfig(path);
    try { return preferencesSchema.parse(text === undefined ? {} : JSON.parse(text)); }
    catch { throw new ModelConfigError("model-preferences.json inválido: confira o JSON e os valores de contextWindow. O arquivo foi preservado."); }
}
export function writeModelPreferences(value: unknown, path = join(myagentHome(), "model-preferences.json")) {
    writePrivateConfig(path, JSON.stringify(preferencesSchema.parse(value), null, 2) + "\n");
}

/** Fonte única para serviços e catálogo da API. Hints vêm do provider resolvido,
 * nunca substituem preferências nem o catálogo; também permitem providers injetados. */
export function resolveContextWindow(modelId: string, hint: { provider?: SupportedProvider; contextWindow?: number } = {}): ContextWindowResolution {
    const preferences = readModelPreferences();
    const custom = readModelConfigEntries(join(myagentHome(), "models.json")).find(model => model.id === modelId);
    const result = (contextWindow: number, contextWindowSource: ContextWindowResolution["contextWindowSource"]): ContextWindowResolution => ({
        contextWindow, contextWindowSource, contextWindowEstimated: contextWindowSource !== "catalog",
    });
    const override = (Object.hasOwn(preferences.contextWindows, modelId) ? preferences.contextWindows[modelId] : undefined) ?? custom?.contextWindow;
    if (override !== undefined) return result(override, "override");
    const slug = modelId.startsWith("chatgpt:") ? modelId.slice(8) : modelId;
    const candidates = SUPPORTED_CHAT_MODELS.filter(model => (!modelId.startsWith("chatgpt:") || model.provider === "openai") && (!custom || model.provider === custom.provider));
    const catalog = candidates.find(model => model.id === slug);
    if (catalog) return result(catalog.contextWindow, "catalog");
    // Só snapshots datados de um ID exato conhecido; não inferir capacidades de
    // famílias novas (gpt-5.6-luna não herda a janela de gpt-5.4).
    const family = candidates.find(model => slug.startsWith(model.id + "-") && /^\d{4}-\d{2}-\d{2}$/.test(slug.slice(model.id.length + 1)));
    if (family) return result(family.contextWindow, "family");
    if (validContextWindow(hint.contextWindow) && !custom && !modelId.startsWith("chatgpt:")) return result(hint.contextWindow, "provider");
    const provider = modelId.startsWith("chatgpt:") ? "chatgpt" : custom?.provider ?? hint.provider;
    return result(!custom && provider && provider !== "ollama" ? DEFAULT_CLOUD_CONTEXT_WINDOW : preferences.defaultLocalContextWindow, "default");
}
