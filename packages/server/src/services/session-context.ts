import type { PrismaClient, Prisma } from "@myagent/database";
import { modelMessageSchema, type ModelMessage } from "ai";
import { messagePartsSchema } from "@myagent/shared";

export const DEFAULT_CONTEXT_TOKEN_LIMIT = 16_384;
const MAX_SOURCE_MESSAGES = 80;
export const CONTEXT_OMISSION_NOTE = "[Janela de contexto: conteúdo anterior foi omitido ou abreviado. O histórico completo permanece salvo. Recupere evidências por leitura; não repita ações com efeitos colaterais para reconstruí-las.]";
type ContextDatabase = Pick<PrismaClient, "message" | "sessionContext">;
type SourceMessage = { role: string; content: string; status: string; parts?: unknown };

// Estimativa independente de provedor, não equivale ao consumo medido pela API.
export function estimateContextTokens(messages: readonly ModelMessage[]): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 3) + messages.length * 12;
}
function excerpt(text: string): string {
    return text.length <= 4_000 ? text : text.slice(0, 3_000) + "\n[conteúdo abreviado]\n" + text.slice(-1_000);
}

/** Reconstrói evidências, sem reasoning interno nem chamadas órfãs executáveis. */
export function contextFromMessages(rows: readonly SourceMessage[]): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (const row of rows) {
        if (row.role === "USER") { messages.push({ role: "user", content: row.content }); continue; }
        const parsed = messagePartsSchema.safeParse(row.parts);
        const parts = parsed.success ? parsed.data : [];
        if (row.role === "ERROR" && parts.length === 0) continue;
        if (!parts.length && !row.content) continue;
        if (row.status === "INTERRUPTED" || row.role === "ERROR") {
            messages.push({ role: "assistant", content: "[Geração anterior interrompida ou falhou. Somente resultados registrados abaixo são evidências de execução.]" });
        }
        if (!parts.length && row.content) messages.push({ role: "assistant", content: excerpt(row.content) });
        const seen = new Set<string>();
        for (const part of parts) {
            if (part.type === "tool-limit-warning") messages.push({ role: "assistant", content: `[Resposta parcial por limite de tool calls (${part.limit}). Há verificações pendentes; não repetir automaticamente ações com efeitos colaterais.]` });
            if (part.type === "text" && part.text) messages.push({ role: "assistant", content: excerpt(part.text) });
            if (part.type !== "tool-call" || seen.has(part.id)) continue;
            seen.add(part.id);
            const result = parts.find(item => item.type === "tool-result" && item.id === part.id && item.name === part.name);
            if (!result || result.type !== "tool-result") {
                messages.push({ role: "assistant", content: `[Chamada ${part.name}, id ${part.id}: resultado indisponível. Não repetir automaticamente efeitos colaterais.]` });
            } else if (JSON.stringify(part.args).length > 8_000) {
                messages.push({ role: "assistant", content: `[Resultado registrado de ${part.name}, id ${part.id}; argumentos omitidos por tamanho]\n${excerpt(result.result)}` });
            } else {
                messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.args }] });
                messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: part.id, toolName: part.name, output: { type: "text", value: excerpt(result.result) } }] });
            }
        }
    }
    return messages;
}

/** Mantém unidades assistant/tool juntas e nunca corta a mensagem atual do usuário. */
export function fitContextWindow(input: readonly ModelMessage[], tokenLimit = DEFAULT_CONTEXT_TOKEN_LIMIT, alreadyTruncated = false) {
    if (!Number.isInteger(tokenLimit) || tokenLimit < 128 || tokenLimit > DEFAULT_CONTEXT_TOKEN_LIMIT) throw new Error("Limite de contexto inválido");
    const parsed = modelMessageSchema.array().parse(input);
    const messages: ModelMessage[] = [];
    // Metadados/reasoning do fluxo atual podem ser exigidos pelo provider.
    // contextFromMessages não os reconstrói em novos turnos.
    for (let i = 0; i < parsed.length; i++) {
        const message = parsed[i]!;
        if (message.role === "user") {
            messages.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n") });
        } else if (message.role === "assistant") {
            if (typeof message.content === "string") {
                if (message.content !== CONTEXT_OMISSION_NOTE) messages.push({ ...message, content: excerpt(message.content) });
                continue;
            }
            const next = parsed[i + 1];
            const results = next?.role === "tool" ? next.content.filter(p => p.type === "tool-result").map(result => {
                if (result.output.type === "text") return { ...result, output: { ...result.output, value: excerpt(result.output.value) } };
                if (result.output.type === "json" && JSON.stringify(result.output.value).length > 4_000) {
                    return { ...result, output: { type: "text" as const, value: excerpt(JSON.stringify(result.output.value)) } };
                }
                return result;
            }) : [];
            const calls = message.content.filter(p => p.type === "tool-call");
            const complete = calls.filter(call => results.some(result => result.toolCallId === call.toolCallId && result.toolName === call.toolName));
            const content = message.content.filter(p => p.type === "text" || p.type === "reasoning" || p.type === "tool-call" && complete.includes(p))
                .map(p => p.type === "text" ? { ...p, text: excerpt(p.text) } : p);
            if (content.length) messages.push({ ...message, content });
            if (complete.length) messages.push({ role: "tool", content: results.filter(result => complete.some(call => call.toolCallId === result.toolCallId && call.toolName === result.toolName)) });
            if (calls.length !== complete.length) messages.push({ role: "assistant", content: "[Chamadas sem resultado foram omitidas; não repetir efeitos automaticamente.]" });
        }
    }
    let truncated = alreadyTruncated || /\[conteúdo abreviado\]|argumentos omitidos por tamanho/.test(JSON.stringify(messages)) || parsed.some(m => m.role === "assistant" && m.content === CONTEXT_OMISSION_NOTE);
    const latestUser = messages.findLast(m => m.role === "user");
    if (latestUser && estimateContextTokens([latestUser]) + 100 > tokenLimit) throw new Error("CONTEXT_MESSAGE_TOO_LARGE: divida a mensagem em partes menores");
    // Cada janela começa em uma solicitação do usuário, nunca no meio de um par.
    while (messages.length && messages[0]?.role !== "user") { messages.shift(); truncated = true; }
    const withNotice = () => truncated && messages.length
        ? [messages[0]!, { role: "assistant" as const, content: CONTEXT_OMISSION_NOTE }, ...messages.slice(1)] : messages;
    while (estimateContextTokens(withNotice()) > tokenLimit && messages.length > 1) {
        const nextUser = messages.findIndex((m, i) => i > 0 && m.role === "user");
        if (nextUser > 0) messages.splice(0, nextUser);
        else {
            // Reduz o turno mais recente por unidades completas, preservando o usuário.
            const amount = messages[2]?.role === "tool" ? 2 : 1;
            messages.splice(1, amount);
        }
        truncated = true;
    }
    const result = withNotice();
    const estimatedTokens = estimateContextTokens(result);
    if (estimatedTokens > tokenLimit) throw new Error("CONTEXT_MESSAGE_TOO_LARGE: divida a mensagem em partes menores");
    return { messages: result, estimatedTokens, truncated, tokenLimit };
}

export async function persistSessionContext(db: ContextDatabase, sessionId: string, messages: readonly ModelMessage[], signal?: AbortSignal, truncated = false) {
    signal?.throwIfAborted();
    const current = await db.sessionContext.findUnique({ where: { sessionId }, select: { tokenLimit: true } });
    const tokenLimit = Math.min(DEFAULT_CONTEXT_TOKEN_LIMIT, Math.max(1_024, current?.tokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT));
    const window = fitContextWindow(messages, tokenLimit, truncated);
    const data = { ...window, messages: JSON.parse(JSON.stringify(window.messages)) as Prisma.InputJsonValue };
    const saved = await db.sessionContext.upsert({ where: { sessionId }, create: { sessionId, ...data }, update: data });
    signal?.throwIfAborted();
    // É a representação retornada pelo banco que entra no pedido ao modelo.
    return modelMessageSchema.array().parse(saved.messages);
}

export async function refreshSessionContext(db: ContextDatabase, sessionId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const recent = await db.message.findMany({ where: { sessionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_SOURCE_MESSAGES + 1,
        select: { role: true, content: true, status: true, parts: true } });
    const truncated = recent.length > MAX_SOURCE_MESSAGES;
    return persistSessionContext(db, sessionId, contextFromMessages(recent.slice(0, MAX_SOURCE_MESSAGES).reverse()), signal, truncated);
}
