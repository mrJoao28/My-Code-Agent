import { expect, test } from "bun:test";
import { DEFAULT_MODEL_CONTEXT_WINDOW, SUPPORTED_CHAT_MODELS, validContextWindow } from "@myagent/shared";
import { parseCustomModels } from "./model-registry";

test("every catalog model has a usable window, with conservative local defaults", () => {
    for (const model of SUPPORTED_CHAT_MODELS) expect(validContextWindow(model.contextWindow)).toBe(true);
    expect(SUPPORTED_CHAT_MODELS.find(m => m.id === "claude-haiku-4-5")?.contextWindow).toBe(200_000);
    expect(SUPPORTED_CHAT_MODELS.find(m => m.id === "gpt-5.4")?.contextWindow).toBe(1_050_000);
    expect(SUPPORTED_CHAT_MODELS.find(m => m.id === "llama3.1")?.contextWindow).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
});

test("models.json accepts custom and Ollama windows and rejects invalid values", () => {
    const models = parseCustomModels([
        { id: "local", provider: "ollama", contextWindow: 131_072 },
        { id: "cloud", provider: "openai" },
    ]);
    expect(models).toHaveLength(2);
    expect(models[0]?.contextWindow).toBe(131_072);
    expect(models[1]?.contextWindow).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(() => parseCustomModels({})).toThrow("models.json inválido");
    for (const contextWindow of [0, -1, 1.5, "200000", 100, Number.MAX_SAFE_INTEGER]) expect(() => parseCustomModels([{ id: "bad", provider: "ollama", contextWindow }])).toThrow();
    expect(() => parseCustomModels([null, {}, { id: "x", provider: "bogus" }])).toThrow();
});
