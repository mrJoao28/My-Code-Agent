import type { PrismaClient, Prisma } from "@myagent/database";
import { checkpoints } from "../security/checkpoints";
import { approvals } from "../security/permissions";
import { logger } from "../lib/logger";

export const SESSION_RETENTION_MS = 10 * 24 * 60 * 60 * 1_000;
export const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
type SessionDatabase = Pick<PrismaClient, "session">;

export function unexpiredSessionFilter(now = new Date()) {
    const cutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
    return { OR: [
        { updatedAt: { gt: cutoff } },
        { messages: { some: { createdAt: { gt: cutoff } } } },
    ] } satisfies Prisma.SessionWhereInput;
}

// Renova antes da leitura, somente dentro do prazo: uma sessão já expirada
// não pode ser reativada entre duas execuções da limpeza.
export async function loadSessionForUse(db: SessionDatabase, sessionId: string, now = new Date()) {
    if (!await markSessionUsed(db, sessionId, now)) return null;
    return db.session.findUnique({
        where: { id: sessionId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
    });
}

export async function markSessionUsed(db: SessionDatabase, sessionId: string, now = new Date()) {
    const updated = await db.session.updateMany({
        where: { id: sessionId, ...unexpiredSessionFilter(now) },
        data: { updatedAt: now },
    });
    return updated.count > 0;
}

export async function deleteInactiveSessions(db: SessionDatabase, now = new Date()) {
    const cutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
    // Uma consulta condicional evita apagar uma sessão renovada entre uma
    // listagem de candidatas e a exclusão. Mensagens recentes protegem também
    // sessões antigas cujo updatedAt não tenha sido atualizado corretamente.
    return db.session.deleteMany({ where: {
        updatedAt: { lte: cutoff },
        messages: { none: { createdAt: { gt: cutoff } } },
    } });
}

type Schedule = (task: () => void, delay: number) => () => void;
const scheduleTimeout: Schedule = (task, delay) => {
    const timer = setTimeout(task, delay);
    timer.unref();
    return () => clearTimeout(timer);
};

export function startSessionCleanup(db: SessionDatabase, schedule: Schedule = scheduleTimeout, cleanupArtifacts: () => Promise<void> = async () => {}) {
    let stopped = false;
    let cancelTimer: (() => void) | undefined;
    const run = async () => {
        if (stopped) return;
        try {
            const { count } = await deleteInactiveSessions(db);
            await cleanupArtifacts();
            if (count > 0) logger.info({ event: "inactive_sessions_deleted", count }, "Inactive sessions deleted");
        } catch {
            // Não registra a exceção do driver: ela pode incluir a conexão.
            logger.warn({ event: "session_cleanup_failed" }, "Session cleanup failed; retrying on the next interval");
        } finally {
            // Agenda só após concluir, inclusive em falhas; não sobrepõe jobs.
            if (!stopped) cancelTimer = schedule(() => { void run(); }, SESSION_CLEANUP_INTERVAL_MS);
        }
    };
    void run();
    return () => {
        stopped = true;
        cancelTimer?.();
    };
}

export async function cleanupSessionArtifacts(db: SessionDatabase) {
    const active = async (id: string) => !!await db.session.findFirst({ where: { id, ...unexpiredSessionFilter() }, select: { id: true } });
    await checkpoints.prune(active);
    for (const id of approvals.sessions()) if (!await active(id)) approvals.forget(id);
}
