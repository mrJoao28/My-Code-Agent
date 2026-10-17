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

export class ToolCallGuard {
    private totalCalls = 0;
    private readonly callCounts = new Map<string, number>();
    constructor(readonly limit = getMaxToolCalls()) {}

    get shouldSummarize(): boolean {
        return this.totalCalls >= Math.max(1, this.limit - 2);
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
