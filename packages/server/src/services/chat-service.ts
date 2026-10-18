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

const activeResumeSessionIds = new Set<string>();
let sessionLeases: SessionLeases | undefined;
export function setChatSessionLeases(leases: SessionLeases | undefined) { sessionLeases = leases; }

export type SubmitBody = { content: string; mode: Mode; model: string };

async function writeSseError(stream: Parameters<Parameters<typeof streamSSE>[1]>[0], message: string) {
  const errorEvent: ChatStreamEvent = { type: "error", message };
  await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
}

export async function handleResume(c: Context) {
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
  const resumableMessage = await db.message.findFirst({ where: { sessionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!resumableMessage || resumableMessage.role !== "USER") { activeResumeSessionIds.delete(sessionId); return c.json({ error: "Session has no pending user message to resume" }, 409); }
  if (!isSupportedChatModel(resumableMessage.model)) { activeResumeSessionIds.delete(sessionId); return c.json({ error: `Session uses unsupported model: ${resumableMessage.model}` }, 409); }
  if (!isModelConfigured(resumableMessage.model)) { activeResumeSessionIds.delete(sessionId); return c.json({ error: "MODEL_API_KEY_REQUIRED", model: resumableMessage.model }, 428); }
  const history = await refreshSessionContext(db, sessionId, c.req.raw.signal, contextBudget(findModel(resumableMessage.model)?.contextWindow).tokenLimit);
  const abortController = new AbortController();
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abortController.abort());
      try {
        await streamAIResponse(stream, { sessionId, model: resumableMessage.model, history, mode: resumableMessage.mode, abortController, cwd: session.cwd, requestSignal: c.req.raw.signal });
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

export async function handleSubmit(c: Context, data: SubmitBody) {
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
