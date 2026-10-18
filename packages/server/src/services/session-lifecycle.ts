import type { PrismaClient, Prisma } from "@myagent/database";
import { checkpoints } from "../security/checkpoints";
import { approvals } from "../security/permissions";
import { logger } from "../lib/logger";

export const SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
type SessionDatabase = Pick<PrismaClient, "session">;

export const SESSION_RETENTION_WARNING_MS = 24 * 60 * 60 * 1_000;
export function sessionRetentionDays(value = process.env.MYAGENT_SESSION_RETENTION_DAYS): number {
    if (value === undefined || value === "") return 90;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 365_000) {
        throw new Error("MYAGENT_SESSION_RETENTION_DAYS deve ser um inteiro entre 0 e 365000.");
    }
    return Number(value);
}
// Sessões avisadas continuam acessíveis: abri-las renova o prazo e cancela a exclusão.

export async function loadSessionForUse(db: SessionDatabase, sessionId: string, now = new Date()) {
    if (!await markSessionUsed(db, sessionId, now)) return null;
    return db.session.findUnique({
        where: { id: sessionId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
    });
}

export async function markSessionUsed(db: SessionDatabase, sessionId: string, now = new Date()) {
    const updated = await db.session.updateMany({
        where: { id: sessionId },
        data: { updatedAt: now, retentionWarnedAt: null },
    });
    return updated.count > 0;
}

export async function deleteInactiveSessions(db: SessionDatabase, now = new Date()) {
    const days = sessionRetentionDays();
    if (days === 0) return { count: 0 };
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
    const inactive: Prisma.SessionWhereInput = {
        updatedAt: { lte: cutoff },
        messages: { none: { OR: [{ createdAt: { gt: cutoff } }, { status: "IN_PROGRESS" }] } },
        OR: [{ lease: null }, { lease: { expiresAt: { lte: BigInt(now.getTime()) } } }],
    };
    const candidates = await db.session.findMany({ where: { ...inactive, retentionWarnedAt: null }, select: { id: true, updatedAt: true }, take: 100 });
    for (const candidate of candidates) {
        const marked = await db.session.updateMany({ where: { ...inactive, id: candidate.id, updatedAt: candidate.updatedAt, retentionWarnedAt: null },
            data: { retentionWarnedAt: now, updatedAt: candidate.updatedAt } });
        if (marked.count) logger.warn({ event: "session_retention_warning", sessionId: candidate.id, deleteAfter: new Date(now.getTime() + SESSION_RETENTION_WARNING_MS).toISOString() },
            "Sessão inativa: será apagada após 24 horas. Abra a sessão para cancelar a exclusão; MYAGENT_SESSION_RETENTION_DAYS=0 desativa a retenção.");
    }
    // A condição é reavaliada no DELETE: renovar/gerar mensagens durante a limpeza protege a sessão.
    const pending = { ...inactive, retentionWarnedAt: { lte: new Date(now.getTime() - SESSION_RETENTION_WARNING_MS) } } satisfies Prisma.SessionWhereInput;
    const count = await db.session.count({ where: pending });
    if (count) logger.warn({ event: "sessions_before_deletion", count }, "Apagando sessões previamente avisadas há pelo menos 24 horas.");
    return db.session.deleteMany({ where: pending });
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
    const active = async (id: string) => !!await db.session.findFirst({ where: { id }, select: { id: true } });
    await checkpoints.prune(active);
    for (const id of approvals.sessions()) if (!await active(id)) approvals.forget(id);
}
