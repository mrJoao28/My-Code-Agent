import type { PrismaClient, Prisma } from "@myagent/database";
import { modelMessageSchema, type ModelMessage } from "ai";
import { SUMMARY_PREFIX, summarizeContext } from "./context-summary";
import { DEFAULT_MODEL_CONTEXT_WINDOW, validContextWindow, messagePartsSchema } from "@myagent/shared";

export const DEFAULT_CONTEXT_TOKEN_LIMIT = DEFAULT_MODEL_CONTEXT_WINDOW;
const MAX_SOURCE_MESSAGES = 80;
export const CONTEXT_OMISSION_NOTE = "[Janela de contexto: conteúdo anterior foi omitido ou abreviado. O histórico completo permanece salvo. Recupere evidências por leitura; não repita ações com efeitos colaterais para reconstruí-las.]";
type ContextDatabase = Pick<PrismaClient, "message" | "sessionContext">;
type SourceMessage = { role: string; content: string; status: string; parts?: unknown };

// Estimativa independente de provedor, não equivale ao consumo medido pela API.
export function estimateContextTokens(messages: readonly ModelMessage[]): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 3) + messages.length * 12;
}
// Páginas limitadas de read_file mantêm conteúdo e nextOffset juntos no contexto.
function isReadFilePage(name: string, text: string): boolean {
    if (name !== "read_file" || text.length > 131_072) return false;
    try {
        const page = JSON.parse(text) as Record<string, unknown>;
        if (!page || typeof page !== "object" || Array.isArray(page)) return false;
        return typeof page.path === "string" && page.path.length <= 32_768
            && typeof page.content === "string" && page.content.length <= 10_000
            && typeof page.totalLines === "number" && Number.isSafeInteger(page.totalLines) && page.totalLines >= 0
            && typeof page.truncated === "boolean"
            && (page.nextOffset === undefined ? !page.truncated
                : typeof page.nextOffset === "number" && Number.isSafeInteger(page.nextOffset) && page.nextOffset >= 0);
    } catch { return false; }
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
        if (!parts.length && row.content) messages.push({ role: "assistant", content: row.content });
        const seen = new Set<string>();
        for (const part of parts) {
            if (part.type === "tool-limit-warning") messages.push({ role: "assistant", content: `[Resposta parcial por limite de tool calls (${part.limit}). Há verificações pendentes; não repetir automaticamente ações com efeitos colaterais.]` });
            if (part.type === "text" && part.text) messages.push({ role: "assistant", content: part.text });
            if (part.type !== "tool-call" || seen.has(part.id)) continue;
            seen.add(part.id);
            const result = parts.find(item => item.type === "tool-result" && item.id === part.id && item.name === part.name);
            if (!result || result.type !== "tool-result") {
                messages.push({ role: "assistant", content: `[Chamada ${part.name}, id ${part.id}: resultado indisponível. Não repetir automaticamente efeitos colaterais.]` });
            } else if (JSON.stringify(part.args).length > 8_000) {
                messages.push({ role: "assistant", content: `[Resultado registrado de ${part.name}, id ${part.id}; argumentos omitidos por tamanho]\n${isReadFilePage(part.name, result.result) ? "Página de read_file omitida: use um caminho relativo menor para manter os argumentos no contexto." : result.result}` });
            } else {
                messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.args }] });
                messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: part.id, toolName: part.name, output: { type: "text", value: result.result } }] });
            }
        }
    }
    return messages;
}

/** Reserva 20% de segurança/saída e desconta system prompt e schemas das tools. */
export function contextBudget(contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW, system = "", toolDefinitions: unknown = {}) {
    if (!validContextWindow(contextWindow)) throw new Error("contextWindow inválido");
    const reservedInputTokens = estimateContextTokens([{ role: "system", content: system + JSON.stringify(toolDefinitions) }]);
    const tokenLimit = Math.floor(contextWindow * 0.8) - reservedInputTokens;
    if (tokenLimit < 128) throw new Error("CONTEXT_MESSAGE_TOO_LARGE: janela insuficiente para o system prompt e ferramentas");
    return { tokenLimit, responseTokens: Math.min(32_768, Math.floor(contextWindow * 0.15)) };
}

/** Corte somente no fim. Páginas de leitura continuam em limites de linhas. */
function shortenResult(result: Extract<ModelMessage, { role: "tool" }>["content"][number], input: unknown, maxTokens: number) {
    if (result.type !== "tool-result") return result;
    const serialized = result.output.type === "text" ? result.output.value
        : result.output.type === "json" ? JSON.stringify(result.output.value) : undefined;
    if (serialized === undefined) return result;
    const chars = Math.max(0, Math.floor(maxTokens * 2)); // JSON e UTF-8 ainda serão medidos após o corte.
    let value: string;
    if (isReadFilePage(result.toolName, serialized)) {
        const page = JSON.parse(serialized) as { content: string; nextOffset?: number; [key: string]: unknown };
        const args = input as { offset?: number; numbered?: boolean } | null;
        const lines = page.content === "" && (page.contextTruncated === true || page.totalLines === 0 || args?.numbered !== false) ? [] : page.content.split("\n");
        const firstNumber = /^(\d+): /.exec(lines[0] ?? "");
        const start = firstNumber && args?.numbered !== false ? Number(firstNumber[1]) - 1 : args?.offset ?? 0;
        const pageWith = (count: number) => {
            const nextOffset = start + count;
            return JSON.stringify({ ...page, content: lines.slice(0, count).join("\n"), truncated: true, contextTruncated: true, nextOffset,
                continuation: `Resultado abreviado no fim pelo orçamento de contexto. Continue com read_file, offset=${nextOffset} e limit=${Math.max(1, Math.min(100, lines.length - count))}.${count === 0 ? " Nenhuma linha coube: prefira grep para localizar trechos ou configure uma janela maior." : ""}` });
        };
        let low = 0, high = lines.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            const candidate = { ...result, output: { type: "text", value: pageWith(mid) } };
            if (Math.ceil(Buffer.byteLength(JSON.stringify(candidate), "utf8") / 3) <= maxTokens) low = mid;
            else high = mid - 1;
        }
        value = pageWith(low);
    } else {
        let prefix = serialized.slice(0, Math.max(0, chars - 180));
        if (result.toolName === "read_file") prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf("\n")));
        value = prefix + "\n[Resultado abreviado no fim pelo orçamento de contexto; refine a consulta ou use offset e limit quando disponíveis.]";
    }
    return { ...result, output: { type: "text" as const, value } };
}

/** Mantém pares íntegros; o histórico completo nunca é alterado. */
export function fitContextWindow(input: readonly ModelMessage[], tokenLimit = DEFAULT_CONTEXT_TOKEN_LIMIT, alreadyTruncated = false) {
    if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 128) throw new Error("Limite de contexto inválido");
    const parsed = modelMessageSchema.array().parse(input);
    let messages: ModelMessage[] = [];
    for (let i = 0; i < parsed.length; i++) {
        const message = parsed[i]!;
        if (message.role === "user") {
            messages.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n") });
        } else if (message.role === "assistant") {
            if (typeof message.content === "string") {
                if (message.content !== CONTEXT_OMISSION_NOTE) messages.push(message);
                continue;
            }
            const next = parsed[i + 1];
            const results = next?.role === "tool" ? next.content.filter(p => p.type === "tool-result") : [];
            const calls = message.content.filter(p => p.type === "tool-call");
            const complete = calls.filter(call => results.some(result => result.toolCallId === call.toolCallId && result.toolName === call.toolName));
            const content = message.content.filter(p => p.type === "text" || p.type === "reasoning" || p.type === "tool-call" && complete.includes(p));
            if (content.length) messages.push({ ...message, content });
            if (complete.length) messages.push({ role: "tool", content: results.filter(result => complete.some(call => call.toolCallId === result.toolCallId && call.toolName === result.toolName)) });
            if (calls.length !== complete.length) messages.push({ role: "assistant", content: "[Chamadas sem resultado foram omitidas; não repetir efeitos automaticamente.]" });
        }
    }
    let truncated = alreadyTruncated || parsed.some(m => m.role === "assistant" && (m.content === CONTEXT_OMISSION_NOTE || typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX)));
    const latestUser = messages.findLast(m => m.role === "user");
    if (latestUser && estimateContextTokens([latestUser]) + 100 > tokenLimit) throw new Error("CONTEXT_MESSAGE_TOO_LARGE: divida a mensagem em partes menores");
    while (messages.length && messages[0]?.role !== "user") { messages.shift(); truncated = true; }
    const withNotice = () => truncated && messages.length
        ? [messages[0]!, { role: "assistant" as const, content: CONTEXT_OMISSION_NOTE }, ...messages.slice(1)] : messages;
    const userIndexes = messages.flatMap((m, i) => m.role === "user" ? [i] : []);
    if (estimateContextTokens(messages) > tokenLimit * 0.7 && userIndexes.length > 2) {
        const boundary = userIndexes.at(-2)!;
        const recentCost = estimateContextTokens(messages.slice(boundary));
        const summarySpace = Math.max(250, Math.floor((tokenLimit - recentCost - 200) * 1.5));
        const summary = summarizeContext(messages.slice(0, boundary), Math.min(12_000, Math.floor(tokenLimit * 0.3), summarySpace));
        messages = [messages[boundary]!, summary, ...messages.slice(boundary + 1)];
        truncated = true;
    }
    // Não comprime resultados quando a janela comporta a evidência completa.
    if (estimateContextTokens(withNotice()) > tokenLimit) {
        const results: { index: number; part: number; args: unknown }[] = [];
        for (let i = 1; i < messages.length; i++) {
            const message = messages[i]!;
            const previous = messages[i - 1];
            if (message.role !== "tool") continue;
            message.content.forEach((part, j) => {
                if (part.type !== "tool-result") return;
                const call = previous?.role === "assistant" && Array.isArray(previous.content)
                    ? previous.content.find(c => c.type === "tool-call" && c.toolCallId === part.toolCallId) : undefined;
                results.push({ index: i, part: j, args: call?.type === "tool-call" ? call.input : undefined });
            });
        }
        // Calcula primeiro o custo estrutural. Evidências recentes recebem o espaço restante.
        const skeleton = structuredClone(messages);
        for (const ref of results) {
            const m = skeleton[ref.index]!;
            if (m.role === "tool") { const p = m.content[ref.part]!; if (p.type === "tool-result") m.content[ref.part] = { ...p, output: { type: "text", value: "" } }; }
        }
        let remaining = Math.max(0, tokenLimit - estimateContextTokens(skeleton) - 200);
        for (const ref of results.toReversed()) {
            const m = messages[ref.index]!;
            if (m.role !== "tool") continue;
            const part = m.content[ref.part]!;
            const cost = Math.ceil(Buffer.byteLength(JSON.stringify(part), "utf8") / 3);
            const allowance = Math.floor(remaining * 0.8);
            const replacement = cost <= allowance ? part : shortenResult(part, ref.args, allowance);
            if (replacement !== part) truncated = true;
            m.content[ref.part] = replacement;
            remaining = Math.max(0, remaining - Math.ceil(Buffer.byteLength(JSON.stringify(replacement), "utf8") / 3));
        }
    }
    while (estimateContextTokens(withNotice()) > tokenLimit && messages.length > 1) {
        const nextUser = messages.findIndex((m, i) => i > 0 && m.role === "user");
        if (nextUser > 0) {
            const summary = summarizeContext(messages.slice(0, nextUser), Math.min(6_000, Math.floor(tokenLimit * 0.2)));
            messages = [messages[nextUser]!, summary, ...messages.slice(nextUser + 1)];
        } else {
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

export async function persistSessionContext(db: ContextDatabase, sessionId: string, messages: readonly ModelMessage[], signal?: AbortSignal, truncated = false, budget?: number) {
    signal?.throwIfAborted();
    const current = await db.sessionContext.findUnique({ where: { sessionId }, select: { tokenLimit: true } });
    const tokenLimit = budget ?? Math.max(128, current?.tokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT);
    const window = fitContextWindow(messages, tokenLimit, truncated);
    const data = { ...window, messages: JSON.parse(JSON.stringify(window.messages)) as Prisma.InputJsonValue };
    const saved = await db.sessionContext.upsert({ where: { sessionId }, create: { sessionId, ...data }, update: data });
    signal?.throwIfAborted();
    // É a representação retornada pelo banco que entra no pedido ao modelo.
    return modelMessageSchema.array().parse(saved.messages);
}

export async function refreshSessionContext(db: ContextDatabase, sessionId: string, signal?: AbortSignal, budget?: number) {
    signal?.throwIfAborted();
    const recent = await db.message.findMany({ where: { sessionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_SOURCE_MESSAGES + 1,
        select: { role: true, content: true, status: true, parts: true } });
    const truncated = recent.length > MAX_SOURCE_MESSAGES;
    const source = contextFromMessages(recent.slice(0, MAX_SOURCE_MESSAGES).reverse());
    const saved = await db.sessionContext.findUnique({ where: { sessionId }, select: { messages: true } });
    const previous = modelMessageSchema.array().safeParse(saved?.messages);
    const summaries = previous.success ? previous.data.filter(m => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX)) : [];
    if (source[0]?.role === "user") source.splice(1, 0, ...summaries);
    return persistSessionContext(db, sessionId, source, signal, truncated, budget);
}
