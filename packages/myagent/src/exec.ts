import { DEFAULT_CHAT_MODEL_ID, chatStreamEventSchema, type ChatStreamEvent } from "@myagent/shared";
import { automationApproves } from "../../server/src/security/permissions";
import type { ExecOptions } from "./options";

export const EXEC_EXIT = { success: 0, failure: 1, denied: 3, cancelled: 130 } as const;
export type ExecResult = {
    type: "exec-result";
    status: keyof typeof EXEC_EXIT;
    exitCode: number;
    text: string;
    model: string;
    sessionId: string;
    totalTokens: number | null;
    toolCalls: number;
    durationMs: number;
    error?: string;
};

// SSE pode dividir UTF-8, CRLF e JSON entre chunks. O limite se aplica ao frame,
// não ao histórico completo; nunca entregamos um resultado parcial como válido.
export async function* readExecEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = "", data: string[] = [], frameSize = 0;
    const parse = () => {
        if (!data.length) return;
        const event = chatStreamEventSchema.parse(JSON.parse(data.join("\n")));
        data = []; frameSize = 0;
        return event;
    };
    try {
        while (true) {
            const chunk = await reader.read();
            pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end).replace(/\r$/, "");
                pending = pending.slice(end + 1);
                if (!line) { const event = parse(); if (event) yield event; }
                else if (line.startsWith("data:")) {
                    const value = line.slice(5).replace(/^ /, "");
                    frameSize += value.length;
                    if (frameSize > 8 * 1024 * 1024) throw new Error("Evento SSE excedeu 8 MiB.");
                    data.push(value);
                }
            }
            if (pending.length + frameSize > 8 * 1024 * 1024) throw new Error("Evento SSE excedeu 8 MiB.");
            if (chunk.done) {
                if (pending) throw new Error("Evento SSE incompleto.");
                const event = parse(); if (event) yield event;
                return;
            }
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

type Connection = { url: string; token: string; workspace: string; sessionId: string; signal: AbortSignal };
export async function executePrompt(options: ExecOptions, connection: Connection, dependencies: {
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    event?: (event: ChatStreamEvent) => void;
} = {}): Promise<ExecResult> {
    const request = dependencies.fetch ?? fetch;
    const start = performance.now();
    const model = options.model ?? DEFAULT_CHAT_MODEL_ID;
    const result: ExecResult = { type: "exec-result", status: "failure", exitCode: 1, text: "", model, sessionId: connection.sessionId, totalTokens: null, toolCalls: 0, durationMs: 0 };
    const headers = { Authorization: `Bearer ${connection.token}`, "X-Myagent-Workspace": connection.workspace, "Content-Type": "application/json" };
    let denied = false, completed = false;
    try {
        const response = await request(`${connection.url}/chat/${encodeURIComponent(connection.sessionId)}`, {
            method: "POST", headers, signal: connection.signal,
            body: JSON.stringify({ content: options.prompt, mode: options.mode.toUpperCase(), model }),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
            throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
        }
        if (!response.body) throw new Error("Resposta sem stream.");
        for await (const event of readExecEvents(response.body)) {
            dependencies.event?.(event);
            if (event.type === "text-delta") {
                result.text += event.text;
                if (result.text.length > 8 * 1024 * 1024) throw new Error("Resposta excedeu 8 MiB.");
            }
            if (event.type === "tool-call") { result.toolCalls++; result.text = ""; }
            if (event.type === "usage") result.totalTokens = event.totalTokens;
            if (event.type === "approval-required") {
                const approved = automationApproves(options.approve, event.toolName, options.allowPush) && !event.confirmation;
                denied ||= !approved;
                const decision = await request(`${connection.url}/permissions/${encodeURIComponent(connection.sessionId)}/${encodeURIComponent(event.approvalId)}`, {
                    method: "POST", headers, signal: connection.signal, body: JSON.stringify({ approved }),
                });
                if (!decision.ok) throw new Error(`Não foi possível responder à aprovação (HTTP ${decision.status}).`);
            }
            if (event.type === "error") throw new Error(event.message);
            if (event.type === "done") { completed = true; break; }
        }
        if (!completed) throw new Error("Stream encerrado sem confirmação de conclusão.");
        result.status = denied ? "denied" : "success";
    } catch (error) {
        result.status = connection.signal.aborted ? "cancelled" : denied ? "denied" : "failure";
        result.error = error instanceof Error ? error.message : "Falha na execução.";
    }
    result.exitCode = EXEC_EXIT[result.status];
    result.durationMs = Math.round(performance.now() - start);
    return result;
}

export async function runExec(options: ExecOptions): Promise<number> {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("Geração cancelada."));
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    let server: Awaited<ReturnType<typeof import("@myagent/server")["startServer"]>> | undefined;
    let closeDatabase: (() => Promise<void>) | undefined;
    try {
        const { loadGlobalConfig } = await import("../../server/src/lib/env");
        loadGlobalConfig();
        const { randomBytes } = await import("node:crypto");
        const { resolveWorkspaceRoot } = await import("../../server/src/utils/workspace");
        const workspace = await resolveWorkspaceRoot(process.cwd(), controller.signal);
        const database = await import("@myagent/database");
        closeDatabase = database.closeDatabase;
        const { db } = await database.initializeDatabase();
        const { selectWorkspaceSession } = await import("../../server/src/services/workspace-sessions");
        // Cada comando começa isolado; nunca retoma efeitos pendentes implicitamente.
        const session = await selectWorkspaceSession(db, workspace, true);
        const { logger } = await import("../../server/src/lib/logger");
        logger.level = "silent";
        const { startServer } = await import("@myagent/server");
        const token = randomBytes(32).toString("hex");
        server = await startServer({ port: 0, token, workspace, sessionId: session.id, automationApproval: options.approve, allowPush: options.allowPush, onLockLost: interrupt, signal: controller.signal });
        const result = await executePrompt(options, { url: server.url, token, workspace, sessionId: session.id, signal: controller.signal }, {
            event: options.json ? event => { console.log(JSON.stringify(event)); } : undefined,
        });
        if (options.json) console.log(JSON.stringify(result));
        else { if (result.text) console.log(result.text); if (result.error) console.error(result.error); }
        return result.exitCode;
    } catch (error) {
        const status = controller.signal.aborted ? "cancelled" : "failure";
        const message = error instanceof Error ? error.message : "Não foi possível iniciar a execução.";
        if (options.json) console.log(JSON.stringify({ type: "exec-result", status, exitCode: EXEC_EXIT[status], text: "", error: message, totalTokens: null, toolCalls: 0, durationMs: 0, model: options.model ?? DEFAULT_CHAT_MODEL_ID }));
        else console.error(message);
        return EXEC_EXIT[status];
    } finally {
        interrupt();
        try { await server?.stop(); }
        finally { await closeDatabase?.(); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
    }
}
