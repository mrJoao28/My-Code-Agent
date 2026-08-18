import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Mode } from "@myagent/database";
import { isModelConfigured, isSupportedChatModel } from "../lib/models";
import { handleResume, handleSubmit } from "../services/chat-service";

const submitSchema = z.object({
  content: z.string().trim().min(1, "Message content is required"),
  mode: z.nativeEnum(Mode),
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
});

const submitValidator = zValidator("json", submitSchema, async (result, c) => {
  if (!result.success) return c.json({ error: "Invalid request body" }, 400);

  const { model } = result.data;
  if (!isModelConfigured(model)) {
    return c.json({
      error: "MODEL_API_KEY_REQUIRED",
      model,
      message: `Configure an API key for ${model} before using this model.`,
    }, 428);
  }
});

const app = new Hono()
  .post("/:sessionId/resume", async (c) => handleResume(c))
  .post("/:sessionId", submitValidator, async (c) => handleSubmit(c, c.req.valid("json")));

export default app;
