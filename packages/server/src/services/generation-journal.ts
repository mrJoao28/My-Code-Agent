import type { PrismaClient } from "@myagent/database";
import { messagePartsSchema, type MessagePart } from "@myagent/shared";
import { extractFullText } from "./message-format";

export const activeSessionGenerations = new Set<string>();
type Database = Pick<PrismaClient, "message">;
const effects = new Set(["write_file", "edit_file", "delete_file", "move_file", "apply_patch", "git_commit", "git_init", "git_switch", "git_remote_add", "git_push", "git_sync", "bash"]);
function canonical(value: unknown): string {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
    return JSON.stringify(value) ?? "null";
}
export function preventEffectReplay(previous: readonly MessagePart[], name: string, input: unknown) {
    if (!effects.has(name)) return;
    const old = previous.find(part => part.type === "tool-call" && part.name === name && canonical(part.args) === canonical(input)
        && (part.execution === "started" || part.execution === undefined));
    if (old) throw new Error("RETOMADA: esta ação já foi iniciada na geração anterior. O resultado registrado deve ser consultado; se não existe, o efeito é desconhecido. Inspecione o estado e peça uma nova instrução ao usuário. Não repetir automaticamente.");
}

/** Uma fila por geração impede que ferramentas paralelas sobrescrevam resultados. */
export class GenerationJournal {
    readonly parts: MessagePart[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    constructor(private db: Database, readonly id: string) {}
    save(extra: { status?: "COMPLETE" | "INTERRUPTED"; totalTokens?: number | null; duration?: number; content?: string } = {}) {
        const write = this.queue.then(() => this.db.message.update({ where: { id: this.id }, data: {
            content: extractFullText(this.parts), parts: structuredClone(this.parts), ...extra,
        } }));
        this.queue = write;
        return write;
    }
    async call(id: string, name: string, args: Extract<MessagePart, { type: "tool-call" }>["args"], started = false) {
        const existing = this.parts.find((part): part is Extract<MessagePart, { type: "tool-call" }> => part.type === "tool-call" && part.id === id);
        if (existing) { if (started) existing.execution = "started"; }
        else this.parts.push({ type: "tool-call", id, name, args, execution: started ? "started" : "pending" });
        await this.save();
    }
    async result(id: string, name: string, output: unknown) {
        if (!this.parts.some(part => part.type === "tool-result" && part.id === id)) {
            this.parts.push({ type: "tool-result", id, name, result: typeof output === "string" ? output : JSON.stringify(output) ?? "null" });
        }
        await this.save();
    }
}

/** Na inicialização só recupera leases ausentes/expirados, preservando outros processos. */
export async function recoverOrphanedGenerations(db: Database, sessionId?: string, now = Date.now()) {
    return db.message.updateMany({ where: {
        role: "ASSISTANT", status: "IN_PROGRESS",
        ...(sessionId ? { sessionId } : { session: { OR: [{ lease: null }, { lease: { expiresAt: { lte: BigInt(now) } } }] } }),
    }, data: { status: "INTERRUPTED" } });
}
export async function previousGenerationParts(db: Database, message: { id: string; generationId: string | null; parts: unknown }) {
    const rows = message.generationId
        ? await db.message.findMany({ where: { OR: [{ generationId: message.generationId }, { id: message.generationId }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }) : [message];
    return rows.flatMap(row => { const parsed = messagePartsSchema.safeParse(row.parts); return parsed.success ? parsed.data : []; });
}
