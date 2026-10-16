import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@myagent/database";

export const LEASE_TIMEOUT_MS = 30_000;
export class SessionBusyError extends Error {
    constructor() { super("Esta pasta já está aberta em outro terminal."); }
}

export class SessionLeases {
    readonly owner = randomUUID();
    private readonly held = new Set<string>();
    private timer?: ReturnType<typeof setTimeout>;
    private stopped = false;
    private pending: Promise<void> = Promise.resolve();
    constructor(private readonly db: Pick<PrismaClient, "$queryRaw" | "sessionLease">, private readonly onLost: () => void = () => {}) {}

    async acquire(sessionId: string, now = Date.now()) {
        if (this.stopped) throw new Error("Gerenciador de locks encerrado.");
        const rows = await this.db.$queryRaw<{ owner: string }[]>`
            INSERT INTO "SessionLease" ("sessionId", "owner", "expiresAt") VALUES (${sessionId}, ${this.owner}, ${BigInt(now + LEASE_TIMEOUT_MS)})
            ON CONFLICT("sessionId") DO UPDATE SET "owner"=excluded."owner", "expiresAt"=excluded."expiresAt"
            WHERE "SessionLease"."expiresAt" <= ${BigInt(now)} OR "SessionLease"."owner" = ${this.owner}
            RETURNING "owner"`;
        if (rows[0]?.owner !== this.owner) throw new SessionBusyError();
        this.held.add(sessionId);
    }

    start() {
        if (this.timer || this.stopped) return;
        const tick = () => {
            this.timer = undefined;
            this.pending = (async () => {
                try {
                    const now = Date.now();
                    for (const sessionId of this.held) {
                        const result = await this.db.sessionLease.updateMany({ where: { sessionId, owner: this.owner, expiresAt: { gt: BigInt(now) } }, data: { expiresAt: BigInt(now + LEASE_TIMEOUT_MS) } });
                        if (result.count !== 1) throw new SessionBusyError();
                    }
                } catch { this.stopped = true; this.onLost(); }
                finally { if (!this.stopped) { this.timer = setTimeout(tick, 5_000); this.timer.unref(); } }
            })();
        };
        this.timer = setTimeout(tick, 5_000);
        this.timer.unref();
    }

    async close() {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.pending;
        await this.db.sessionLease.deleteMany({ where: { owner: this.owner } });
        this.held.clear();
    }
}
