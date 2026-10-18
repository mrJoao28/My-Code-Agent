import { expect, mock, test } from "bun:test";
import { deleteInactiveSessions, loadSessionForUse, startSessionCleanup, unexpiredSessionFilter,
    SESSION_CLEANUP_INTERVAL_MS, SESSION_RETENTION_MS } from "./session-lifecycle";

const now = new Date("2026-10-15T12:00:00Z");
const cutoff = new Date("2026-10-05T12:00:00Z");
function database(session: object) {
    return { session } as unknown as Parameters<typeof deleteInactiveSessions>[0];
}
const flush = () => Bun.sleep(0);

test("retention deletes at ten full days with one conditional query and protects recent messages", async () => {
    const deleteMany = mock(async (_args: unknown) => ({ count: 2 }));
    expect(await deleteInactiveSessions(database({ deleteMany }), now)).toEqual({ count: 2 });
    expect(SESSION_RETENTION_MS).toBe(864_000_000);
    expect(deleteMany.mock.calls).toEqual([[{ where: {
        updatedAt: { lte: cutoff }, messages: { none: { createdAt: { gt: cutoff } } },
    } }]]);
    expect(unexpiredSessionFilter(now)).toEqual({ OR: [
        { updatedAt: { gt: cutoff } }, { messages: { some: { createdAt: { gt: cutoff } } } },
    ] });
});

test("using a session must renew activity before reading its history", async () => {
    let release!: (value: { count: number }) => void;
    const updateMany = mock((_args: unknown) => new Promise<{ count: number }>(resolve => { release = resolve; }));
    const findUnique = mock(async (_args: unknown) => ({ id: "s", messages: [] }));
    const result = loadSessionForUse(database({ updateMany, findUnique }), "s", now);
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany.mock.calls[0]).toEqual([{ where: { id: "s", ...unexpiredSessionFilter(now) }, data: { updatedAt: now } }]);
    release({ count: 1 });
    expect(await result).toMatchObject({ id: "s", messages: [] });
    expect(findUnique).toHaveBeenCalledTimes(1);
});

test("expired or concurrently deleted sessions are not loaded or recreated", async () => {
    const findUnique = mock(async () => ({ id: "s" }));
    const db = database({ updateMany: async () => ({ count: 0 }), findUnique });
    expect(await loadSessionForUse(db, "s", now)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
});

test("failed activity renewal prevents loading and starting a generation", async () => {
    const findUnique = mock(async () => ({ id: "s" }));
    const db = database({ updateMany: async () => { throw new Error("fixture unavailable"); }, findUnique });
    await expect(loadSessionForUse(db, "s", now)).rejects.toThrow("fixture unavailable");
    expect(findUnique).not.toHaveBeenCalled();
});

function scheduler() {
    const tasks: { run: () => void; delay: number; cancelled: boolean }[] = [];
    return { tasks, schedule: (run: () => void, delay: number) => {
        const task = { run, delay, cancelled: false };
        tasks.push(task);
        return () => { task.cancelled = true; };
    } };
}

test("cleanup runs at startup, repeats hourly and stops its timer", async () => {
    const deleteMany = mock(async () => ({ count: 0 }));
    const clock = scheduler();
    const stop = startSessionCleanup(database({ deleteMany }), clock.schedule);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    await flush();
    expect(clock.tasks[0]!.delay).toBe(SESSION_CLEANUP_INTERVAL_MS);
    expect(SESSION_CLEANUP_INTERVAL_MS).toBe(3_600_000);
    clock.tasks[0]!.run();
    await flush();
    expect(deleteMany).toHaveBeenCalledTimes(2);
    stop();
    expect(clock.tasks[1]!.cancelled).toBe(true);
    clock.tasks[1]!.run(); // Um callback já enfileirado também deve ser ignorado.
    expect(deleteMany).toHaveBeenCalledTimes(2);
});

test("cleanup retries database failures without an unhandled rejection", async () => {
    let attempts = 0;
    const deleteMany = mock(async () => {
        if (++attempts === 1) throw new Error("fixture unavailable");
        return { count: 1 };
    });
    const clock = scheduler();
    const stop = startSessionCleanup(database({ deleteMany }), clock.schedule);
    try {
        await flush();
        expect(clock.tasks).toHaveLength(1);
        clock.tasks[0]!.run();
        await flush();
        expect(attempts).toBe(2);
        expect(clock.tasks).toHaveLength(2);
    } finally { stop(); }
});

test("slow cleanup does not overlap and stopping it prevents rescheduling", async () => {
    let release!: (value: { count: number }) => void;
    const deleteMany = mock(() => new Promise<{ count: number }>(resolve => { release = resolve; }));
    const clock = scheduler();
    const stop = startSessionCleanup(database({ deleteMany }), clock.schedule);
    await flush();
    expect(clock.tasks).toHaveLength(0);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    stop();
    release({ count: 0 });
    await flush();
    expect(clock.tasks).toHaveLength(0);
});

test("checkpoint cleanup follows session retention and finishes before scheduling another pass", async () => {
    const calls: string[] = [];
    const clock = scheduler();
    const stop = startSessionCleanup(database({ deleteMany: async () => { calls.push("retention"); return { count: 0 }; } }), clock.schedule,
        async () => { calls.push("checkpoints"); });
    await flush();
    expect(calls).toEqual(["retention", "checkpoints"]);
    expect(clock.tasks).toHaveLength(1);
    stop();
});
