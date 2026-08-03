import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { SupportedProvider } from "@myagent/shared";
import {
  addCustomModel,
  findModel,
  getAllModels,
  getModelApiKeyEnv,
  isModelConfigured,
} from "../lib/model-registry";
import { upsertEnvValue } from "../lib/env";

const providerSchema = z.enum(["anthropic", "openai", "google", "ollama"]);
const addModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  provider: providerSchema,
  token: z.string().trim().optional(),
});
const configureModelSchema = z.object({ token: z.string().trim().min(1) });

const app = new Hono()
  .get("/", (c) =>
    c.json(
      getAllModels().map((model) => ({
        ...model,
        configured: isModelConfigured(model.id),
      })),
    ),
  )
  .post("/", zValidator("json", addModelSchema), async (c) => {
    const { id, provider, token } = c.req.valid("json");

    if (findModel(id)) {
      return c.json({ error: `Model already exists: ${id}` }, 409);
    }

    if (provider !== "ollama" && !token) {
      return c.json({ error: "An API key is required for cloud models" }, 400);
    }

    const envKey = provider === "ollama" ? undefined : makeApiKeyEnvName(provider, id);

    try {
      if (envKey && token) upsertEnvValue(envKey, token);

      const model = addCustomModel({
        id,
        provider: provider as SupportedProvider,
        apiKeyEnv: envKey,
      });

      return c.json({
        model: {
          id: model.id,
          provider: model.provider,
          pricing: model.pricing,
          configured: isModelConfigured(model.id),
        },
      }, 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Failed to add model" },
        400,
      );
    }
  })
  .post("/:id/key", zValidator("json", configureModelSchema), async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const model = findModel(id);

    if (!model) return c.json({ error: `Unknown model: ${id}` }, 404);
    if (model.provider === "ollama") {
      return c.json({ error: "Local Ollama models do not require an API key" }, 400);
    }

    const envKey = getModelApiKeyEnv(model);
    if (!envKey) return c.json({ error: "Model API key is not configurable" }, 400);

    const { token } = c.req.valid("json");
    upsertEnvValue(envKey, token);

    return c.json({ configured: true });
  });

function makeApiKeyEnvName(provider: string, modelId: string) {
  const normalized = modelId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `MYAGENT_${provider.toUpperCase()}_${normalized}_API_KEY`;
}

export default app;
