import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { db } from "@myagent/database";
import { Mode, MessageStatus } from "@myagent/database";
import type { ChatStreamEvent } from "@myagent/shared";
import { isSupportedChatModel } from "../lib/models";
import { buildConversationHistory, getResumableUserMessage } from "./message-service";
import { streamAIResponse } from "./stream-service";
import { logger } from "../lib/logger";


const activeResumeSessionIds = new Set<string>();

export type SubmitBody = {
    content: string;
    mode: Mode;
    model: string;
};

async function writeSseError(stream: Parameters<Parameters<typeof streamSSE>[1]>[0], message: string) {
    const errorEvent: ChatStreamEvent = { type: "error", message };
    await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
}

export async function handleResume(c: Context) {
    const sessionId = c.req.param("sessionId");

    const session = await db.session.findUnique({
        where: { id: sessionId },
        include: { messages: { orderBy: { createdAt: "asc" } } }
    });
    if (!session) {
        return c.json({ error: "Session not found" }, 404);
    }
    const resumableMessage = getResumableUserMessage(session.messages);

    if (!resumableMessage) {
        return c.json({ error: "Session has no pending user message to resume" }, 409);
    }
    if (!isSupportedChatModel(resumableMessage.model)) {
        return c.json({ error: `Session uses unsupported model: ${resumableMessage.model}` }, 409);
    }

    if (activeResumeSessionIds.has(sessionId)) {
        return c.json({ error: "Session already has an active generation" }, 409);
    }

    activeResumeSessionIds.add(sessionId);

    const history = buildConversationHistory(session.messages);
    const abortController = new AbortController();
    try {
        return streamSSE(
            c,
            async (stream) => {
                stream.onAbort(() => {
                    abortController.abort();
                });

                try {
                    await streamAIResponse(stream, {
                        sessionId,
                        model: resumableMessage.model,
                        history,
                        mode: resumableMessage.mode,
                        abortController,
                        cwd: session.cwd
                    });
                } finally {
                    activeResumeSessionIds.delete(sessionId);
                }
            },
            async (err, stream) => {
                activeResumeSessionIds.delete(sessionId);
                const message = err instanceof Error ? err.message : String(err);
                logger.error({ sessionId, event: "resume_stream_error", err: message }, "Resume stream failed");
                await writeSseError(stream, message);
            }
        );
    } catch (e) {
        activeResumeSessionIds.delete(sessionId);
        throw e;
    }
}

export async function handleSubmit(c: Context, data: SubmitBody) {
    const sessionId = c.req.param("sessionId");

    if (activeResumeSessionIds.has(sessionId)) {
        return c.json({ error: "Session already has an active generation" }, 409);
    }

    const session = await db.session.findUnique({
        where: { id: sessionId },
        include: { messages: { orderBy: { createdAt: "asc" } } }
    });

    if (!session) {
        return c.json({ error: "Session not found" }, 404);
    }

    await db.message.create({
        data: {
            sessionId,
            role: "USER",
            status: MessageStatus.COMPLETE,
            model: data.model,
            content: data.content,
            mode: data.mode
        }
    });

    const history = buildConversationHistory([
        ...session.messages,
        { role: "USER" as const, content: data.content, status: MessageStatus.COMPLETE }
    ]);

    const abortController = new AbortController();
    activeResumeSessionIds.add(sessionId);

    return streamSSE(
        c,
        async (stream) => {
            stream.onAbort(() => {
                abortController.abort();
            });
            try {
                await streamAIResponse(stream, {
                    sessionId,
                    model: data.model,
                    history,
                    mode: data.mode,
                    abortController,
                    cwd: session.cwd
                });
            } finally {
                activeResumeSessionIds.delete(sessionId);
            }
        },
        async (err, stream) => {
            activeResumeSessionIds.delete(sessionId);
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ sessionId, event: "submit_stream_error", err: message }, "Submit stream failed");
            await writeSseError(stream, message);
        }
    );
}
