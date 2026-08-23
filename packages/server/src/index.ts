import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Prisma } from "@myagent/database";
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

  // BUGFIX: antes só logávamos `error.message`/`error.stack`. Para
  // erros do Prisma (PrismaClientKnownRequestError), a informação mais
  // útil para diagnosticar (o código, ex. "P2021" = tabela não existe,
  // "P2022" = coluna não existe, "P2002" = valor duplicado, e o `meta`
  // com o nome exato da tabela/coluna/constraint envolvida) fica dentro
  // de um `code`/`meta` separados — nunca aparecia no log. A mensagem
  // "pretty" do Prisma também é longa e multi-linha, então em um
  // terminal estreito ela parece "cortada"; aqui imprimimos o essencial
  // primeiro, de forma compacta, antes do texto completo.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    logger.error(
      {
        requestId,
        event: "prisma_known_request_error",
        path: c.req.path,
        method: c.req.method,
        code: error.code,
        meta: error.meta,
      },
      `Prisma error ${error.code}: ${error.message.split("\n").filter(Boolean).pop() ?? error.message}`,
    );
    // Também imprime a mensagem completa (com o code frame do Prisma)
    // direto no stdout, fora do JSON de uma linha só do pino — assim
    // ela não fica espremida/cortada visualmente no terminal.
    console.error(`\n[prisma:${error.code}]`, error.message, "\n");

    return c.json({ error: `Database error (${error.code})`, code: error.code }, 500);
  }

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