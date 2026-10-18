import { streamText as aiStreamText, stepCountIs } from "ai";
import type { PrismaClient } from "@myagent/database";
import { MessageStatus, type Mode } from "@myagent/database/enums";
import type { ChatStreamEvent, MessagePart } from "@myagent/shared";
import { toolCallArgsSchema } from "@myagent/shared";
import { resolveChatModel } from "../lib/models";
import { buildSystemPrompt } from "../prompts";
import { createTools, GLOBAL_GENERATION_TIMEOUT_MS, ToolCallGuard, ToolCallLimitError, ToolLoopDetectedError } from "./tool-service";
import { extractFullText, serializeParts } from "./message-format";
import { logger } from "../lib/logger";
import type { ModelMessage } from "ai";
import { contextBudget, persistSessionContext, refreshSessionContext } from "./session-context";
import { findModel } from "../lib/model-registry";
import { ProjectInstructions } from "../lib/project-instructions";
import { authorizeWorkspace } from "../security/workspaces";
import { isDockerAvailable } from "../security/sandbox";

const generations = new Set<{ controller: AbortController; done: Promise<void> }>();

export async function cancelAllGenerations() {
    const active = [...generations];
    for (const generation of active) generation.controller.abort(new Error("Aplicação encerrada."));
    await Promise.all(active.map(generation => generation.done));
}

type StreamSSEArg = Parameters<Parameters<typeof import("hono/streaming").streamSSE>[1]>[0];

export type StreamParams = {
    sessionId: string;
    model: string;
    history: ModelMessage[];
    mode: Mode;
    abortController: AbortController;
    cwd: string | null;
    requestSignal?: AbortSignal;
};

export type StreamDependencies = {
    db: Pick<PrismaClient, "message" | "sessionContext">;
    touchSession: (sessionId: string) => Promise<void>;
    resolveModel: typeof resolveChatModel;
    generate: typeof aiStreamText;
    saveContext: (messages: ModelMessage[], signal: AbortSignal) => Promise<ModelMessage[]>;
    refreshContext: () => Promise<unknown>;
};
export async function streamAIResponse(stream: StreamSSEArg, params: StreamParams, dependencies: Partial<StreamDependencies> = {}): Promise<void> {
    let finish!: () => void;
    const generation = { controller: params.abortController, done: new Promise<void>(resolve => { finish = resolve; }) };
    generations.add(generation);
    try { await runAIResponse(stream, params, dependencies); }
    finally { generations.delete(generation); finish(); }
}

async function runAIResponse(stream: StreamSSEArg, params: StreamParams, dependencies: Partial<StreamDependencies> = {}): Promise<void> {
    const db = dependencies.db ?? (await import("@myagent/database")).db;
    const touchSession = dependencies.touchSession ?? (await import("./message-service")).touchSession;
    const { sessionId, model, history, mode, abortController, cwd } = params;
    const abortRequest = () => abortController.abort(params.requestSignal?.reason);
    params.requestSignal?.addEventListener("abort", abortRequest, { once: true });
    if (params.requestSignal?.aborted) abortRequest();
    let budget: ReturnType<typeof contextBudget> | undefined;
    const saveContext = dependencies.saveContext ?? ((messages, signal) => persistSessionContext(db, sessionId, messages, signal, false, budget?.tokenLimit));
    const refreshContext = dependencies.refreshContext ?? (() => refreshSessionContext(db, sessionId, undefined, budget?.tokenLimit));
    const refreshAfterPersistence = async () => {
        try { await refreshContext(); }
        catch { logger.warn({ sessionId, event: "context_refresh_failed" }, "Context will be rebuilt from persisted messages before the next generation"); }
    };
    const startTime = Date.now();
    const toolGuard = new ToolCallGuard();
    const instructions = cwd ? new ProjectInstructions(cwd) : undefined;
    let finalToolLimitStep = false;
    const tools = cwd ? createTools(cwd, mode, sessionId, {
        beforeExecute: (name, input) => {
            if (finalToolLimitStep) throw new ToolCallLimitError(toolGuard.limit);
            try { toolGuard.register(name, input); }
            catch (error) {
                if (error instanceof ToolLoopDetectedError) abortController.abort(error);
                throw error;
            }
        },
        notify: async event => { await stream.writeSSE({ event: event.type, data: JSON.stringify(event) }); },
    }, instructions) : undefined;
    const parts: MessagePart[] = [];
    let totalTokens: number | null = null;
    let messagePersisted = false;


    const globalTimeout = setTimeout(() => {
        logger.warn({ sessionId, event: "global_generation_timeout" }, "Generation exceeded global timeout");
        abortController.abort(new Error("GENERATION_TIMEOUT: limite de cinco minutos excedido"));
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
        await refreshAfterPersistence();
    };

    const persistAndSignalInterruption = async () => {
        await persistInterruptedMessage();
        if (!stream.aborted) {
            const reason = abortController.signal.reason;
            const message = reason instanceof ToolLoopDetectedError || reason instanceof Error && reason.message.startsWith("GENERATION_TIMEOUT:")
                ? reason.message : "Geração interrompida.";
            const event: ChatStreamEvent = { type: "error", message };
            await stream.writeSSE({ event: "error", data: JSON.stringify(event) });
        }
    };

    let detachProviderAbort: (() => void) | undefined;
    try {
        abortController.signal.throwIfAborted();
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
        abortController.signal.throwIfAborted();
        if (cwd) await authorizeWorkspace(cwd);
        const projectInstructions = await instructions?.root(abortController.signal);
        const system = buildSystemPrompt({ cwd: cwd ?? "", mode, availableTools: Object.keys(configuredTools ?? {}), sandboxConfigured: isDockerAvailable(), maxToolCalls: toolGuard.limit, projectInstructions });
        budget = contextBudget(resolvedModel.contextWindow ?? findModel(model)?.contextWindow, system, configuredTools);
        const result = (dependencies.generate ?? aiStreamText)({
            model: resolvedModel.model,
            system,
            maxOutputTokens: budget.responseTokens,
            tools: configuredTools,
            stopWhen: tools ? stepCountIs(toolGuard.limit + 1) : undefined,
            messages: history,
            prepareStep: async ({ messages }) => {
                abortController.signal.throwIfAborted();
                const boundedMessages = await saveContext(messages, abortController.signal);
                toolGuard.updateContext(boundedMessages);
                if (!toolGuard.shouldSummarize) return { messages: boundedMessages };
                if (!finalToolLimitStep) {
                    finalToolLimitStep = true;
                    const warning: Extract<MessagePart, { type: "tool-limit-warning" }> = { type: "tool-limit-warning", limit: toolGuard.limit };
                    parts.push(warning);
                    await stream.writeSSE({ event: warning.type, data: JSON.stringify(warning) });
                }
                return {
                    activeTools: [],
                    toolChoice: "none",
                    messages: [...boundedMessages, { role: "user", content: "Finalize agora SEM ferramentas: apresente uma resposta parcial por limite de tool calls. Resuma o que já apurou com base nos resultados disponíveis, diferencie achados de hipóteses e diga o que ficou por verificar. Não repita ações; sugira continuar ou restringir o escopo." }],
                };
            },
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
            await persistAndSignalInterruption();
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
        await refreshAfterPersistence();

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
            await persistAndSignalInterruption();
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
                parts: serializeParts(parts),
                totalTokens,
                mode
            }
        });
        await touchSession(sessionId);
        await refreshAfterPersistence();

        const errorEvent: ChatStreamEvent = { type: "error", message };
        await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
    } finally {
        params.requestSignal?.removeEventListener("abort", abortRequest);
        detachProviderAbort?.();
        clearTimeout(globalTimeout);
    }
}
