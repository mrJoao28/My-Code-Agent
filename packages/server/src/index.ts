import { ModelConfigError } from "./lib/model-config";
import { recoverOrphanedGenerations } from "./services/generation-journal";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Prisma } from "@myagent/database";
import { createSessionRoutes } from "./routes/sessions";
import { db, initializeDatabase, closeDatabase } from "@myagent/database";
import { bodyLimit } from "hono/body-limit";
import { ensureLocalToken, localAuthentication } from "./security/auth";
import { createPermissionRoutes } from "./routes/permissions";
import { UnsafePathError, PathNotFoundError } from "./utils/path";
import chat from "./routes/chat";
import models from "./routes/models";
import { createChatGPTRoutes } from "./routes/chatgpt";
import { logger, generateRequestId } from "./lib/logger";
import { startSessionCleanup, cleanupSessionArtifacts } from "./services/session-lifecycle";
import { SessionBusyError, SessionLeases } from "./services/session-lease";
import { setChatSessionLeases } from "./services/chat-service";
import { setRuntimeWorkspace, validateSessionWorkspace } from "./security/workspaces";
import { workspaceTitle } from "./utils/workspace";
import { cancelAllGenerations } from "./services/stream-service";
import { loadGlobalConfig } from "./lib/env";
import { checkDocker, setDockerAvailable, isDockerAvailable } from "./security/sandbox";
import { chatGPT } from "./lib/chatgpt";
import { approvals, type AutomationApproval } from "./security/permissions";
declare const MYAGENT_BUNDLED: boolean;

export function createApp(token: string, leases?: SessionLeases) {
const app = new Hono<{ Variables: { requestId: string } }>();
app.use("*", localAuthentication(token));
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));

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
  if (error instanceof ModelConfigError) return c.json({ error: error.message }, 503);
  if (error instanceof SessionBusyError) return c.json({ error: error.message }, 409);
  if (error instanceof UnsafePathError) return c.json({ error: error.message }, 403);
  if (error instanceof PathNotFoundError) return c.json({ error: error.message }, 404);

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
  .get("/runtime", c => c.json({ dockerAvailable: isDockerAvailable() }))
  .route("/session", createSessionRoutes(db, undefined, leases, db))
  .route("/chat", chat)
  .route("/models", models)
  .route("/chatgpt", createChatGPTRoutes())
  .route("/permissions", createPermissionRoutes());

return routes;
}

export type AppType = ReturnType<typeof createApp>;

export async function startServer(options: { port?: number; token: string; workspace: string; sessionId?: string; automationApproval?: AutomationApproval; allowPush?: boolean; onLockLost?: () => void; dockerAvailable?: boolean; signal?: AbortSignal; development?: boolean }) {
  if (options.automationApproval !== undefined && !options.sessionId) throw new Error("Automação exige uma sessão explícita.");
  const workspace = await workspaceTitle(options.workspace);
  const docker = options.dockerAvailable ?? await checkDocker(options.signal);
  setDockerAvailable(docker);
  if (!options.development) setRuntimeWorkspace(workspace);
  const leases = new SessionLeases(db, () => { void cancelAllGenerations(); options.onLockLost?.(); });
  let stopCleanup: (() => void) | undefined;
  try {
    await recoverOrphanedGenerations(db);
    if (options.sessionId) {
      const session = await db.session.findUnique({ where: { id: options.sessionId } });
      if (!session) throw new Error("Sessão não encontrada.");
      await validateSessionWorkspace(session, workspace);
      await leases.acquire(options.sessionId);
    }
    if (options.automationApproval !== undefined) approvals.setAutomation(options.sessionId!, options.automationApproval, options.allowPush);
    const app = createApp(options.token, leases);
    const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 0, fetch: app.fetch, idleTimeout: 255 });
    setChatSessionLeases(leases);
    leases.start();
    stopCleanup = startSessionCleanup(db, undefined, () => cleanupSessionArtifacts(db));
    let stopping: Promise<void> | undefined;
    return { server, url: `http://127.0.0.1:${server.port}`, leases, dockerAvailable: docker,
      stop() {
        return stopping ??= (async () => {
          stopCleanup?.();
          chatGPT.cancelLogin();
          try { await cancelAllGenerations(); await server.stop(true); }
          finally { if (options.automationApproval !== undefined) approvals.forget(options.sessionId!); await leases.close(); setChatSessionLeases(undefined); setRuntimeWorkspace(undefined); setDockerAvailable(false); }
        })();
      },
    };
  } catch (error) { if (options.automationApproval !== undefined) approvals.forget(options.sessionId!); stopCleanup?.(); await leases.close(); setRuntimeWorkspace(undefined); throw error; }
}

if (import.meta.main && (typeof MYAGENT_BUNDLED === "undefined" || !MYAGENT_BUNDLED)) {
  loadGlobalConfig();
  const runtime = globalThis as typeof globalThis & { stopMyagentServer?: () => Promise<void> };
  await runtime.stopMyagentServer?.();
  await initializeDatabase();
  const running = await startServer({ port: 3000, token: ensureLocalToken(), workspace: process.cwd(), development: true });
  const stop = async () => {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await running.stop(); await closeDatabase();
  };
  runtime.stopMyagentServer = stop;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`API local em ${running.url}`);
}
