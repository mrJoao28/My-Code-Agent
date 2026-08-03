import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sessions from "./routes/sessions";
import chat from "./routes/chat";
import models from "./routes/models";
import { logger, generateRequestId } from "./lib/logger";

const app = new Hono<{ Variables: { requestId: string } }>();

app.use(async (c, next) => {
  const requestId = generateRequestId();
  const startTime = Date.now();
  c.set("requestId", requestId);

  await next();

  const durationMs = Date.now() - startTime;
  logger.info(
    {
      requestId,
      event: "request",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
    },
    "Request handled",
  );
});

app.onError((error, c) => {
  const requestId = c.get("requestId") ?? "unknown";

  logger.error(
    {
      requestId,
      event: "unhandled_error",
      path: c.req.path,
      method: c.req.method,
      err: error instanceof Error
        ? { message: error.message, stack: error.stack }
        : String(error),
    },
    "Request failed",
  );

  if (error instanceof HTTPException) {
    return c.json({ error: error.message || "Request failed" }, error.status);
  }
  return c.json({ error: "Internal server error" }, 500);
});

const routes = app
  .route("/session", sessions)
  .route("/chat", chat)
  .route("/models", models);

export type AppType = typeof routes;

export default { port: 3000, fetch: app.fetch, idleTimeout: 255 };
