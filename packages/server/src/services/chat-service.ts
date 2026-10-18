import { activeSessionGenerations, previousGenerationParts, recoverOrphanedGenerations } from "./generation-journal";
import { checkpoints, UndoConflictError } from "../security/checkpoints";
import { DEFAULT_CHAT_MODEL_ID } from "@myagent/shared";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { db } from "@myagent/database";
import { Mode, MessageStatus } from "@myagent/database";
import type { ChatStreamEvent } from "@myagent/shared";
import { isModelConfigured, isSupportedChatModel } from "../lib/models";
import { findModel } from "../lib/model-registry";
import { touchSession } from "./message-service";
import { streamAIResponse } from "./stream-service";
import { logger } from "../lib/logger";
import { validateSessionWorkspace } from "../security/workspaces";
import type { SessionLeases } from "./session-lease";
import { markSessionUsed } from "./session-lifecycle";
import { contextBudget, fitContextWindow, refreshSessionContext } from "./session-context";

const activeResumeSessionIds = activeSessionGenerations;
let sessionLeases: SessionLeases | undefined;
export function setChatSessionLeases(leases: SessionLeases | undefined) { sessionLeases = leases; }

export type SubmitBody = { content: string; mode: Mode; model: string };

async function writeSseError(stream: Parameters<Parameters<typeof streamSSE>[1]>[0], message: string) {
  const errorEvent: ChatStreamEvent = { type: "error", message };
  await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
}

export type ChatDependencies = {
  db: typeof db;
  streamAIResponse: typeof streamAIResponse;
  validateSessionWorkspace: typeof validateSessionWorkspace;
  isSupportedChatModel: typeof isSupportedChatModel;
  isModelConfigured: typeof isModelConfigured;
  touchSession: typeof touchSession;
};
const chatDependencies: ChatDependencies = { db, streamAIResponse, validateSessionWorkspace, isSupportedChatModel, isModelConfigured, touchSession };

export async function handleResume(c: Context, dependencies: ChatDependencies = chatDependencies) {
  const { db, streamAIResponse, validateSessionWorkspace, isSupportedChatModel, isModelConfigured } = dependencies;
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "Session id is required" }, 400);
  if (activeResumeSessionIds.has(sessionId)) return c.json({ error: "Session already has an active generation" }, 409);
  activeResumeSessionIds.add(sessionId);
  try {
  const session = await db.session.findUnique({ where: { id: sessionId } });
  if (!session) { activeResumeSessionIds.delete(sessionId); return c.json({ error: "Session not found" }, 404); }

  await validateSessionWorkspace(session, c.req.header("X-Myagent-Workspace"));
  await sessionLeases?.acquire(sessionId);
  if (!await markSessionUsed(db, sessionId)) { activeResumeSessionIds.delete(sessionId); return c.json({ error: "Session not found" }, 404); }
  await recoverOrphanedGenerations(db, sessionId);
  const resumableMessage = await db.message.findFirst({ where: { sessionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!resumableMessage || !(resumableMessage.role === "USER" || resumableMessage.role === "ASSISTANT" && resumableMessage.status === "INTERRUPTED")) { activeResumeSessionIds.delete(sessionId); return c.json({ error: "Session has no pending user message to resume" }, 409); }
  if (!isSupportedChatModel(resumableMessage.model)) { activeResumeSessionIds.delete(sessionId); return c.json({ error: `Session uses unsupported model: ${resumableMessage.model}` }, 409); }
  if (!isModelConfigured(resumableMessage.model)) { activeResumeSessionIds.delete(sessionId); return c.json({ error: "MODEL_API_KEY_REQUIRED", model: resumableMessage.model }, 428); }
  const previousParts = resumableMessage.role === "ASSISTANT" ? await previousGenerationParts(db, resumableMessage) : [];
  const history = await refreshSessionContext(db, sessionId, c.req.raw.signal, contextBudget(findModel(resumableMessage.model)?.contextWindow).tokenLimit);
  const abortController = new AbortController();
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abortController.abort());
      try {
        await streamAIResponse(stream, { sessionId, generationId: resumableMessage.generationId ?? (resumableMessage.role === "ASSISTANT" ? resumableMessage.id : undefined), previousParts, model: resumableMessage.model, history, mode: resumableMessage.mode, abortController, cwd: session.cwd, requestSignal: c.req.raw.signal });
      } finally {
        activeResumeSessionIds.delete(sessionId);
      }
    }, async (err, stream) => {
      activeResumeSessionIds.delete(sessionId);
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ sessionId, event: "resume_stream_error", err: message }, "Resume stream failed");
      await writeSseError(stream, message);
    });
  } catch (e) {
    activeResumeSessionIds.delete(sessionId);
    if (e instanceof Error && e.message.startsWith("CONTEXT_MESSAGE_TOO_LARGE")) return c.json({ error: e.message }, 413);
    throw e;
  }
}

export async function handleSubmit(c: Context, data: SubmitBody, dependencies: ChatDependencies = chatDependencies) {
  const { db, streamAIResponse, validateSessionWorkspace, touchSession } = dependencies;
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "Session id is required" }, 400);

  // BUGFIX: o lock precisa ser adquirido de forma síncrona, ANTES de
  // qualquer `await`. Antes, o `activeResumeSessionIds.add(sessionId)`
  // só acontecia depois de duas operações assíncronas (findUnique +
  // message.create), então duas requisições concorrentes para a mesma
  // sessão passavam ambas pelo `if (activeResumeSessionIds.has(...))`
  // antes de qualquer uma travar o lock, resultando em duas gerações
  // de IA rodando ao mesmo tempo na mesma sessão — violando a garantia
  // de "uma sessão não pode ter gerações concorrentes" que o restante
  // do sistema assume (ver `handleResume`, que já fazia isso certo).
  if (activeResumeSessionIds.has(sessionId)) return c.json({ error: "Session already has an active generation" }, 409);
  activeResumeSessionIds.add(sessionId);

  try {
    fitContextWindow([{ role: "user", content: data.content }], contextBudget(findModel(data.model)?.contextWindow).tokenLimit);
    const session = await db.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      activeResumeSessionIds.delete(sessionId);
      return c.json({ error: "Session not found" }, 404);
    }

    await validateSessionWorkspace(session, c.req.header("X-Myagent-Workspace"));
    await sessionLeases?.acquire(sessionId);
    await recoverOrphanedGenerations(db, sessionId);
    if (!await markSessionUsed(db, sessionId)) { activeResumeSessionIds.delete(sessionId); return c.json({ error: "Session not found" }, 404); }
    await db.message.create({ data: { sessionId, role: "USER", status: MessageStatus.COMPLETE, model: data.model, content: data.content, mode: data.mode } });
    // BUGFIX: `Session.updatedAt` nunca era tocado, então a sessão não
    // subia na listagem (ordenada por atividade recente) assim que o
    // usuário mandava uma nova mensagem. Veja touchSession em message-service.ts.
    await touchSession(sessionId);
    const history = await refreshSessionContext(db, sessionId, c.req.raw.signal, contextBudget(findModel(data.model)?.contextWindow).tokenLimit);
    const abortController = new AbortController();

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abortController.abort());
      try {
        await streamAIResponse(stream, { sessionId, model: data.model, history, mode: data.mode, abortController, cwd: session.cwd, requestSignal: c.req.raw.signal });
      } finally {
        activeResumeSessionIds.delete(sessionId);
      }
    }, async (err, stream) => {
      activeResumeSessionIds.delete(sessionId);
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ sessionId, event: "submit_stream_error", err: message }, "Submit stream failed");
      await writeSseError(stream, message);
    });
  } catch (e) {
    activeResumeSessionIds.delete(sessionId);
    if (e instanceof Error && e.message.startsWith("CONTEXT_MESSAGE_TOO_LARGE")) return c.json({ error: e.message }, 413);
    throw e;
  }
}

export type UndoDependencies = {
    db: typeof db;
    store: typeof checkpoints;
    validate: typeof validateSessionWorkspace;
    touch: (sessionId: string) => Promise<void>;
};
export async function handleUndo(c: Context, dependencies: UndoDependencies = { db, store: checkpoints, validate: validateSessionWorkspace, touch: touchSession }) {
    const { db, store, validate, touch } = dependencies;
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return c.json({ error: "Sessão necessária." }, 400);
    if (activeResumeSessionIds.has(sessionId)) return c.json({ error: "Interrompa a geração antes de usar /undo." }, 409);
    activeResumeSessionIds.add(sessionId);
    try {
        const session = await db.session.findUnique({ where: { id: sessionId } });
        if (!session) return c.json({ error: "Sessão não encontrada." }, 404);
        await validate(session, c.req.header("X-Myagent-Workspace"));
        await sessionLeases?.acquire(sessionId);
        if (!await markSessionUsed(db, sessionId)) return c.json({ error: "Sessão expirada." }, 404);
        if (!session.cwd) return c.json({ error: "Sessão sem workspace." }, 409);
        const result = await store.undo(session.cwd, sessionId);
        const content = `[UNDO] ${result.message} O estado anterior das ferramentas foi desfeito; releia os arquivos antes de continuar.`;
        const model = DEFAULT_CHAT_MODEL_ID;
        const saved = await db.message.create({ data: { sessionId, role: "ASSISTANT", status: "COMPLETE", model, mode: "BUILD", content, parts: [{ type: "text", text: content }], totalTokens: 0 } });
        await touch(sessionId);
        return c.json({ ...result, messageId: saved.id, content, model });
    } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Não foi possível desfazer." }, error instanceof UndoConflictError ? 409 : 400);
    } finally { activeResumeSessionIds.delete(sessionId); }
}
