import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { SupportedProvider } from "@myagent/shared";
import { SUPPORTED_CHAT_MODELS } from "@myagent/shared";
import { addCustomModel, getAllModels } from "../lib/model-registry";
import { upsertEnvValue } from "../lib/env";

const providerSchema = z.enum(["anthropic", "openai", "google", "ollama"]);

const addModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  provider: providerSchema,
  token: z.string().trim().optional(),
});

const app = new Hono()
  .get("/", (c) => {
    return c.json(getAllModels());
  })
  .post("/", zValidator("json", addModelSchema), async (c) => {
    const { id, provider, token } = c.req.valid("json");

    if (provider !== "ollama" && !token) {
      return c.json({ error: "A provider token is required for cloud models" }, 400);
    }

    const isBuiltIn = SUPPORTED_CHAT_MODELS.some((model) => model.id === id);
    if (isBuiltIn) {
      return c.json({ error: `Model already exists: ${id}` }, 409);
    }

    const envKey = provider === "ollama" ? undefined : makeApiKeyEnvName(provider, id);

    try {
      if (envKey && token) {
        upsertEnvValue(envKey, token);
      }

      const model = addCustomModel({
        id,
        provider: provider as SupportedProvider,
        apiKeyEnv: envKey,
      });

      return c.json(
        {
          model: {
            id: model.id,
            provider: model.provider,
            pricing: model.pricing,
          },
        },
        201,
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Failed to add model" },
        400,
      );
    }
  });

function makeApiKeyEnvName(provider: string, modelId: string) {
  const normalized = modelId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `MYAGENT_${provider.toUpperCase()}_${normalized}_API_KEY`;
}

export default app;
