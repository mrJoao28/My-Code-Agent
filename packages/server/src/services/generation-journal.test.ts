import { removeTestDatabase } from "../../../database/src/test-cleanup";
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { openDatabase } from "../../../database/src/client";
import { withFixture as withWorkspaceFixture, type Fixture } from "../test-support";
import { contextFromMessages } from "./session-context";
import { GenerationJournal, preventEffectReplay, previousGenerationParts, recoverOrphanedGenerations } from "./generation-journal";

// A coleta ocorre depois que a função do teste solta referências do adapter nativo.
function withFixture(fn: (fixture: Fixture) => Promise<void>) {
    return withWorkspaceFixture(async fixture => {
        try { await fn(fixture); }
        finally { await removeTestDatabase(join(fixture.root, "db")); }
    });
}

test("journal serializes parallel calls/results, survives reopen and protects other live leases", withFixture(async ({ root }) => {
    const home = join(root, "db");
    let database = await openDatabase({ home });
    try {
        const { db } = database;
        for (const id of ["orphan", "live"]) await db.session.create({ data: { id, userId: "local-user", title: id, workspacePath: root } });
        await db.sessionLease.create({ data: { sessionId: "live", owner: "another-process", expiresAt: BigInt(Date.now() + 60000) } });
        for (const id of ["orphan", "live"]) await db.message.create({ data: { id, sessionId: id, generationId: id, role: "ASSISTANT", status: "IN_PROGRESS", mode: "BUILD", model: "fixture", content: "" } });
        const journal = new GenerationJournal(db, "orphan");
        await Promise.all(Array.from({ length: 30 }, (_, i) => journal.call(String(i), "read_file", { path: `${i}.ts` }, true)));
        await Promise.all(Array.from({ length: 30 }, (_, i) => journal.result(String(i), "read_file", `evidence ${i}`)));
        const live = contextFromMessages([{ role: "ASSISTANT", status: "INTERRUPTED", content: "", parts: journal.parts }]);
        await database.close(); database = await openDatabase({ home });
        expect((await recoverOrphanedGenerations(database.db)).count).toBe(1);
        const saved = await database.db.message.findUniqueOrThrow({ where: { id: "orphan" } });
        expect(saved.status).toBe("INTERRUPTED");
        expect(contextFromMessages([saved])).toEqual(live);
        expect((await database.db.message.findUniqueOrThrow({ where: { id: "live" } })).status).toBe("IN_PROGRESS");
    } finally { await database.close(); }
}));

test("resume blocks completed/unknown effects across continuations, but allows unexecuted approval and reads", withFixture(async ({ root }) => {
    const database = await openDatabase({ home: join(root, "db") });
    try {
        const { db } = database;
        await db.session.create({ data: { id: "s", title: "s", userId: "local-user", workspacePath: root } });
        for (const [id, execution] of [["a", "started"], ["b", "pending"]] as const) await db.message.create({ data: {
            id, sessionId: "s", generationId: id === "a" ? null : "a", role: "ASSISTANT", status: "INTERRUPTED", mode: "BUILD", model: "fixture", content: "",
            parts: [{ type: "tool-call", id, name: "write_file", args: { path: id, content: "saved" }, execution }],
        } });
        const latest = await db.message.findUniqueOrThrow({ where: { id: "b" } });
        const parts = await previousGenerationParts(db, latest);
        expect(() => preventEffectReplay(parts, "write_file", { content: "saved", path: "a" })).toThrow("RETOMADA");
        expect(() => preventEffectReplay(parts, "write_file", { path: "b", content: "saved" })).not.toThrow();
        expect(() => preventEffectReplay(parts, "read_file", { path: "a" })).not.toThrow();
        const pending = parts.find(part => part.type === "tool-call" && part.id === "b");
        if (pending?.type === "tool-call") pending.execution = "started";
        parts.push({ type: "tool-result", id: "b", name: "write_file", result: "saved" });
        expect(() => preventEffectReplay(parts, "write_file", { path: "b", content: "saved" })).toThrow("RETOMADA");
    } finally { await database.close(); }
}));

test.each([false, true])("killed process retains tool intent and completed result=%s without replay", completedCrashCase => withFixture(async ({ root, cwd }) => {
    const home = join(root, "db");
    const database = await openDatabase({ home });
    const source = (path: string) => JSON.stringify(pathToFileURL(resolve(import.meta.dirname, path)).href);
    const childSource = `
        import { openDatabase } from ${source("../../../database/src/client.ts")};
        import { GenerationJournal } from ${source("./generation-journal.ts")};
        import { secureTools } from ${source("../security/tool-policy.ts")};
        import { ApprovalManager } from ${source("../security/permissions.ts")};
        import { writeFile } from "node:fs/promises";
        const database = await openDatabase({ home: ${JSON.stringify(home)} });
        const journal = new GenerationJournal(database.db, "crash");
        const manager = new ApprovalManager();
        const tools = secureTools({ write_file: { execute: async () => {
            await writeFile(${JSON.stringify(join(cwd, "effect.txt"))}, "one effect");
            if (!process.argv.includes("complete")) { console.log("READY"); setInterval(() => {}, 1000); await new Promise(() => {}); }
            return { saved: true };
        } } }, ${JSON.stringify(cwd)}, "BUILD", "s", {
            authorize: async path => path, manager,
            notify: async event => { manager.decide("s", event.approvalId, true); },
            beforeExecute: (name, args, id) => journal.call(id, name, args),
            beforeEffect: (name, args, id) => journal.call(id, name, args, true),
            afterExecute: (name, id, result) => journal.result(id, name, result),
        });
        await tools.write_file.execute({ path: "effect.txt", content: "one effect" }, { toolCallId: "effect", messages: [] });
        console.log("READY");
        setInterval(() => {}, 1000);
    `;
    const script = join(root, "crash.ts");
    await writeFile(script, childSource);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
        await database.db.session.create({ data: { id: "s", userId: "local-user", title: "s", workspacePath: cwd } });
        await database.db.message.create({ data: { id: "crash", generationId: "crash", sessionId: "s", role: "ASSISTANT", status: "IN_PROGRESS", model: "fixture", mode: "BUILD", content: "", parts: [] } });
        const launched = Bun.spawn([process.execPath, script, ...(completedCrashCase ? ["complete"] : [])], { stdout: "pipe", stderr: "pipe" });
        child = launched;
        const reader = launched.stdout.getReader();
        const ready = await Promise.race([reader.read(), Bun.sleep(10000).then(() => { throw new Error("child timeout"); })]);
        expect(new TextDecoder().decode(ready.value)).toContain("READY");
        reader.releaseLock();
        child.kill(9); await child.exited;
        expect(await readFile(join(cwd, "effect.txt"), "utf8")).toBe("one effect");
        expect((await recoverOrphanedGenerations(database.db)).count).toBe(1);
        const message = await database.db.message.findUniqueOrThrow({ where: { id: "crash" } });
        expect(message.status).toBe("INTERRUPTED");
        const parts = await previousGenerationParts(database.db, message);
        expect(parts.some(part => part.type === "tool-result")).toBe(completedCrashCase);
        expect(() => preventEffectReplay(parts, "write_file", { path: "effect.txt", content: "one effect" })).toThrow("RETOMADA");
    } finally { if (child && child.exitCode === null) { child.kill(9); await child.exited; } await database.close(); }
})(), 20000);
