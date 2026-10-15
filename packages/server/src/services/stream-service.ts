import { streamText as aiStreamText, stepCountIs } from "ai";
import type { PrismaClient } from "@myagent/database";
import { MessageStatus, type Mode } from "@myagent/database/enums";
import type { ChatStreamEvent, MessagePart } from "@myagent/shared";
import { toolCallArgsSchema } from "@myagent/shared";
import { resolveChatModel } from "../lib/models";
import { buildSystemPrompt } from "../prompts";
import { createTools, GLOBAL_GENERATION_TIMEOUT_MS, ToolCallGuard, ToolLoopDetectedError } from "./tool-service";
import { extractFullText, serializeParts } from "./message-format";
import { logger } from "../lib/logger";

const MAX_STEPS = 50;

type StreamSSEArg = Parameters<Parameters<typeof import("hono/streaming").streamSSE>[1]>[0];

export type StreamParams = {
    sessionId: string;
    model: string;
    history: { role: "user" | "assistant"; content: string }[];
    mode: Mode;
    abortController: AbortController;
    cwd: string | null;
};

export type StreamDependencies = {
    db: Pick<PrismaClient, "message">;
    touchSession: (sessionId: string) => Promise<void>;
    resolveModel: typeof resolveChatModel;
    generate: typeof aiStreamText;
};
export async function streamAIResponse(stream: StreamSSEArg, params: StreamParams, dependencies: Partial<StreamDependencies> = {}): Promise<void> {
    const db = dependencies.db ?? (await import("@myagent/database")).db;
    const touchSession = dependencies.touchSession ?? (await import("./message-service")).touchSession;
    const { sessionId, model, history, mode, abortController, cwd } = params;
    const startTime = Date.now();
    const toolGuard = new ToolCallGuard();
    const tools = cwd ? createTools(cwd, mode, sessionId, {
        beforeExecute: (name, input) => {
            try { toolGuard.register(name, input); }
            catch (error) { abortController.abort(); throw error; }
        },
        notify: async event => { await stream.writeSSE({ event: event.type, data: JSON.stringify(event) }); },
    }) : undefined;
    const parts: MessagePart[] = [];
    let totalTokens: number | null = null;
    let messagePersisted = false;


    const globalTimeout = setTimeout(() => {
        logger.warn({ sessionId, event: "global_generation_timeout" }, "Generation exceeded global timeout");
        abortController.abort();
    }, GLOBAL_GENERATION_TIMEOUT_MS);


    const persistInterruptedMessage = async (extraNote?: string) => {
        const fullText = extractFullText(parts);

        if (fullText.length === 0 && parts.length === 0 && totalTokens === null) return;
        const elapsedMs = Date.now() - startTime;
        const validatedParts = serializeParts(parts);

        await db.message.create({
            data: {
                sessionId,
                role: "ASSISTANT",
                status: MessageStatus.INTERRUPTED,
                model,
                content: extraNote ? `${fullText}\n\n[${extraNote}]` : fullText,
                parts: validatedParts,
                totalTokens,
                mode,
                duration: Math.round(elapsedMs / 1000)
            }
        });
        messagePersisted = true;
        await touchSession(sessionId);
    };

    let detachProviderAbort: (() => void) | undefined;
    try {
        const resolvedModel = (dependencies.resolveModel ?? resolveChatModel)(model);
        if (resolvedModel.abortSignal) {
            const providerSignal = resolvedModel.abortSignal;
            const abort = () => abortController.abort(providerSignal.reason);
            providerSignal.addEventListener("abort", abort, { once: true });
            detachProviderAbort = () => providerSignal.removeEventListener("abort", abort);
            if (providerSignal.aborted) abort();
        }
        const configuredTools = tools && resolvedModel.toolOptions
            ? Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition, providerOptions: resolvedModel.toolOptions }]))
            : tools;
        const result = (dependencies.generate ?? aiStreamText)({
            model: resolvedModel.model,
            system: buildSystemPrompt({ cwd: cwd ?? "", mode }),
            tools: configuredTools,
            stopWhen: tools ? stepCountIs(MAX_STEPS) : undefined,
            messages: history,
            abortSignal: abortController.signal,
            providerOptions: resolvedModel.providerOptions,
            maxRetries: resolvedModel.maxRetries,
            onError: () => {}, // O fullStream abaixo já trata e registra os erros.
        });

        for await (const part of result.fullStream) {
            if (stream.aborted) break;

            if (part.type === "finish-step") {
                const reported = part.usage.totalTokens ?? (
                    part.usage.inputTokens === undefined && part.usage.outputTokens === undefined
                        ? undefined
                        : (part.usage.inputTokens ?? 0) + (part.usage.outputTokens ?? 0)
                );
                if (reported !== undefined && Number.isSafeInteger(reported) && reported >= 0) {
                    totalTokens = Math.min(2_147_483_647, (totalTokens ?? 0) + reported);
                    const event: ChatStreamEvent = { type: "usage", totalTokens };
                    await stream.writeSSE({ event: "usage", data: JSON.stringify(event) });
                }
            }

            if (part.type === "reasoning-delta") {
                const last = parts[parts.length - 1];
                if (last && last.type === "reasoning") {
                    last.text += part.text;
                } else {
                    parts.push({ type: "reasoning", text: part.text });
                }
                const event: ChatStreamEvent = { type: "reasoning-delta", text: part.text };
                await stream.writeSSE({ event: "reasoning-delta", data: JSON.stringify(event) });
            }

            if (part.type === "text-delta") {
                const last = parts[parts.length - 1];
                if (last && last.type === "text") {
                    last.text += part.text;
                } else {
                    parts.push({ type: "text", text: part.text });
                }
                const event: ChatStreamEvent = { type: "text-delta", text: part.text };
                await stream.writeSSE({ event: "text-delta", data: JSON.stringify(event) });
            }

            if (part.type === "tool-call") {
                const args = toolCallArgsSchema.parse(part.input);


                try {
                    abortController.signal.throwIfAborted();
                } catch (e) {
                    if (e instanceof ToolLoopDetectedError) {
                        logger.warn(
                            { sessionId, event: "tool_loop_detected", toolName: part.toolName },
                            e.message
                        );
                        abortController.abort();
                        break;
                    }
                    throw e;
                }

                parts.push({
                    type: "tool-call",
                    id: part.toolCallId,
                    name: part.toolName,
                    args
                });

                const event: ChatStreamEvent = {
                    type: "tool-call",
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    args
                };
                await stream.writeSSE({ event: "tool-call", data: JSON.stringify(event) });
            }

            if (part.type === "tool-result" || part.type === "tool-error") {
                const resultStr = part.type === "tool-error"
                    ? "Tool failed: " + (part.error instanceof Error ? part.error.message : String(part.error))
                    : typeof part.output === "string" ? part.output : JSON.stringify(part.output);

                const tcPart = parts.find(
                    (p): p is Extract<MessagePart, { type: "tool-call" }> =>
                        p.type === "tool-call" && p.id === part.toolCallId
                );
                if (tcPart) {
                    parts.push({
                        type: "tool-result",
                        id: part.toolCallId,
                        name: tcPart.name,
                        result: resultStr
                    });
                }

                const event: ChatStreamEvent = {
                    type: "tool-result",
                    toolCallId: part.toolCallId,
                    toolName: tcPart?.name ?? "unknown",
                    result: resultStr
                };

                await stream.writeSSE({ event: "tool-result", data: JSON.stringify(event) });
            }

            if (part.type === "error") {
                throw part.error;
            }
        }

        if (stream.aborted || abortController.signal.aborted) {
            await persistInterruptedMessage();
            return;
        }

        const elapsedMs = Date.now() - startTime;
        const fullText = extractFullText(parts);
        const validatedParts = serializeParts(parts);

        const assistantMessage = await db.message.create({
            data: {
                sessionId,
                role: "ASSISTANT",
                status: MessageStatus.COMPLETE,
                model,
                content: fullText,
                parts: validatedParts,
                totalTokens,
                mode,
                duration: Math.round(elapsedMs / 1000)
            }
        });
        messagePersisted = true;
        await touchSession(sessionId);

        logger.info(
            {
                sessionId,
                event: "generation_complete",
                model,
                mode,
                durationMs: elapsedMs,
                toolCalls: parts.filter((p) => p.type === "tool-call").length
            },
            "Generation completed"
        );

        const doneEvent: ChatStreamEvent = {
            type: "done",
            messageId: assistantMessage.id,
            durationMs: elapsedMs
        };

        await stream.writeSSE({ event: "done", data: JSON.stringify(doneEvent) });
    } catch (e) {
        if (messagePersisted) {
            logger.warn({ sessionId, event: "post_persistence_failure" }, "Generation was already persisted; skipping duplicate message");
            return;
        }
        if (abortController.signal.aborted) {
            await persistInterruptedMessage();
            return;
        }

        const message = e instanceof Error ? e.message : String(e);

        logger.error({ sessionId, event: "generation_error", model, mode, err: message }, "Generation failed");

        await db.message.create({
            data: {
                sessionId,
                role: "ERROR",
                status: MessageStatus.COMPLETE,
                model,
                content: message,
                totalTokens,
                mode
            }
        });
        await touchSession(sessionId);

        const errorEvent: ChatStreamEvent = { type: "error", message };
        await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
    } finally {
        detachProviderAbort?.();
        clearTimeout(globalTimeout);
    }
}
