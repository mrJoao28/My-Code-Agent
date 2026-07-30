import { streamText as aiStreamText, stepCountIs } from "ai";
import { db } from "@myagent/database";
import { Mode, MessageStatus } from "@myagent/database";
import type { ChatStreamEvent, MessagePart } from "@myagent/shared";
import { toolCallArgsSchema } from "@myagent/shared";
import { resolveChatModel } from "../lib/models";
import { buildSystemPrompt } from "../prompts";
import { createTools, GLOBAL_GENERATION_TIMEOUT_MS, ToolCallGuard, ToolLoopDetectedError } from "./tool-service";
import { extractFullText, serializeParts } from "./message-service";
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

export async function streamAIResponse(stream: StreamSSEArg, params: StreamParams): Promise<void> {
    const { sessionId, model, history, mode, abortController, cwd } = params;
    const startTime = Date.now();
    const tools = cwd ? createTools(cwd, mode) : undefined;
    const parts: MessagePart[] = [];
    const toolGuard = new ToolCallGuard();


    const globalTimeout = setTimeout(() => {
        logger.warn({ sessionId, event: "global_generation_timeout" }, "Generation exceeded global timeout");
        abortController.abort();
    }, GLOBAL_GENERATION_TIMEOUT_MS);

    const resolvedModel = resolveChatModel(model);

    const persistInterruptedMessage = async (extraNote?: string) => {
        const fullText = extractFullText(parts);

        if (fullText.length === 0 && parts.length === 0) return;
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
                mode,
                duration: Math.round(elapsedMs / 1000)
            }
        });
    };

    try {
        const result = aiStreamText({
            model: resolvedModel.model,
            system: buildSystemPrompt({ cwd: cwd ?? "", mode }),
            tools,
            stopWhen: tools ? stepCountIs(MAX_STEPS) : undefined,
            messages: history,
            abortSignal: abortController.signal,
            providerOptions: resolvedModel.providerOptions
        });

        for await (const part of result.fullStream) {
            if (stream.aborted) break;

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
                    toolGuard.register(part.toolName, args);
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

            if (part.type === "tool-result") {
                const resultStr = typeof part.output === "string" ? part.output : JSON.stringify(part.output);

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
                mode,
                duration: Math.round(elapsedMs / 1000)
            }
        });

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
                mode
            }
        });

        const errorEvent: ChatStreamEvent = { type: "error", message };
        await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
    } finally {
        clearTimeout(globalTimeout);
    }
}
