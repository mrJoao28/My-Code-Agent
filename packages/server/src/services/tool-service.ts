import type { ModelMessage } from "ai";
export { createTools } from "../tools";

/** Máximo de tool calls permitidas em uma única geração. */
export const MAX_TOOL_CALLS = 40;
export const MAX_TOOL_CALLS_CEILING = 200;

export function getMaxToolCalls(value = process.env.MYAGENT_MAX_TOOL_CALLS): number {
    if (!value || !/^[1-9]\d*$/.test(value)) return MAX_TOOL_CALLS;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_TOOL_CALLS_CEILING) : MAX_TOOL_CALLS;
}

export class ToolCallLimitError extends Error {
    constructor(limit: number) {
        super(`Limite máximo de tool calls (${limit}) atingido; finalize com os resultados disponíveis.`);
        this.name = "ToolCallLimitError";
    }
}

/** Máximo de vezes que a mesma chamada (tool + argumentos) pode se repetir
 * antes de considerarmos que o modelo entrou em loop. */
export const MAX_IDENTICAL_REPEATS = 3;

/** Timeout global (parede) para uma geração inteira, incluindo todos os
 * passos de tool-use. Independente do timeout por-step do provider. */
export const GLOBAL_GENERATION_TIMEOUT_MS = 5 * 60_000;

export class ToolLoopDetectedError extends Error {
    constructor(reason: string) {
        super(`Execução interrompida: ${reason}`);
        this.name = "ToolLoopDetectedError";
    }
}

export class ToolResultAlreadyAvailableError extends Error {
    constructor(toolName: string) {
        super(`O resultado de ${toolName} com esses argumentos já foi obtido e continua no contexto. Use a evidência disponível; para outra página, altere offset e limit. Não repita a mesma chamada.`);
        this.name = "ToolResultAlreadyAvailableError";
    }
}

export class ToolCallGuard {
    private totalCalls = 0;
    private readonly callCounts = new Map<string, number>();
    constructor(readonly limit = getMaxToolCalls()) {}

    get shouldSummarize(): boolean {
        return this.totalCalls >= Math.max(1, this.limit - 2);
    }

    /** O snapshot efetivamente enviado ao modelo define quais repetições são evitáveis. */
    updateContext(messages: readonly ModelMessage[]): void {
        const available = new Set<string>();
        const readsByPath = new Map<string, Set<string>>();
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i]!;
            if (message.role === "assistant") {
                const texts = typeof message.content === "string" ? [message.content] : message.content.flatMap(part => part.type === "text" ? [part.text] : []);
                if (texts.some(text => text.startsWith("[UNDO] "))) {
                    // A nota persistida invalida evidências anteriores; não altera permissões
                    // nem o orçamento total de chamadas, que continuam no backend.
                    available.clear(); readsByPath.clear();
                }
            }
            const resultMessage = messages[i + 1];
            if (message.role !== "assistant" || typeof message.content === "string" || resultMessage?.role !== "tool") continue;
            for (const call of message.content) {
                if (call.type !== "tool-call") continue;
                const result = resultMessage.content.find(p => p.type === "tool-result" && p.toolCallId === call.toolCallId && p.toolName === call.toolName);
                if (!result || result.type !== "tool-result" || result.output.type.startsWith("error")) continue;
                const text = result.output.type === "text" ? result.output.value : result.output.type === "json" ? JSON.stringify(result.output.value) : "";
                if (/^(Tool failed:|Error:)/.test(text) || text.includes('"contextTruncated":true') || text.includes("[Resultado abreviado")) continue;
                const args = call.input as { path?: unknown } | null;
                const path = args && typeof args.path === "string" ? args.path : undefined;
                if (path && ["edit_file", "write_file"].includes(call.toolName)) {
                    // Uma leitura anterior à edição deixou de representar o arquivo atual.
                    for (const key of readsByPath.get(path) ?? []) available.delete(key);
                    readsByPath.delete(path);
                }
                const key = `${call.toolName}:${safeStableStringify(call.input)}`;
                available.add(key);
                if (path && call.toolName === "read_file") {
                    const keys = readsByPath.get(path) ?? new Set<string>();
                    keys.add(key); readsByPath.set(path, keys);
                }
            }
        }
        for (const key of this.callCounts.keys()) if (!available.has(key)) this.callCounts.delete(key);
        for (const key of available) if (!this.callCounts.has(key)) this.callCounts.set(key, 1);
    }

    register(toolName: string, args: unknown): void {
        if (this.totalCalls >= this.limit) throw new ToolCallLimitError(this.limit);
        this.totalCalls++;

        const key = `${toolName}:${safeStableStringify(args)}`;
        const count = (this.callCounts.get(key) ?? 0) + 1;
        this.callCounts.set(key, count);

        if (count > MAX_IDENTICAL_REPEATS) {
            throw new ToolLoopDetectedError(
                `a mesma chamada para "${toolName}" com os mesmos argumentos se repetiu ${count} vezes — possível loop.`
            );
        }
        if (count > 1) throw new ToolResultAlreadyAvailableError(toolName);
    }
}

function safeStableStringify(value: unknown): string {
    const seen = new WeakSet<object>();

    const normalize = (input: unknown): unknown => {
        if (input === null || typeof input !== "object") {
            if (typeof input === "bigint") return input.toString();
            if (typeof input === "number" && !Number.isFinite(input)) return String(input);
            return input;
        }

        if (seen.has(input)) {
            throw new TypeError("Cannot serialize circular tool arguments");
        }
        seen.add(input);

        if (Array.isArray(input)) {
            const normalized = input.map(normalize);
            seen.delete(input);
            return normalized;
        }

        const record = input as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            normalized[key] = normalize(record[key]);
        }
        seen.delete(input);
        return normalized;
    };

    try {
        return JSON.stringify(normalize(value));
    } catch {
        return String(value);
    }
}
