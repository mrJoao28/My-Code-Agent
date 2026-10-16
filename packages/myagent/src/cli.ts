#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { parseOptions, HELP } from "./options";
import { version } from "../package.json";

export async function main(args = process.argv.slice(2)) {
    if (typeof Bun === "undefined") throw new Error("My-Code-Agent requer Bun >= 1.3.13. Instale em https://bun.sh.");
    if (Bun.semver.order(Bun.version, "1.3.13") < 0) throw new Error("My-Code-Agent requer Bun >= 1.3.13. Atualize em https://bun.sh.");
    const options = parseOptions(args);
    if (options.command === "version") { console.log(version); return; }
    if (options.command === "help") { console.log(HELP); return; }
    const { loadGlobalConfig } = await import("../../server/src/lib/env");
    loadGlobalConfig();
    if (options.command === "doctor") { const { doctor } = await import("./doctor"); await doctor(); return; }

    const { initializeDatabase, closeDatabase } = await import("@myagent/database");
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("Aplicação encerrada."));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let server: Awaited<ReturnType<typeof import("@myagent/server")["startServer"]>> | undefined;
    let cui: Awaited<ReturnType<typeof import("@myagent/cui")["startCui"]>> | undefined;
    try {
        const { resolveWorkspaceRoot } = await import("../../server/src/utils/workspace");
        let workspace = await resolveWorkspaceRoot(process.cwd(), controller.signal);
        const database = await initializeDatabase();
        const { selectWorkspaceSession } = await import("../../server/src/services/workspace-sessions");
        let session;
        if (options.command === "resume") {
            const { chooseSession } = await import("./resume");
            session = await chooseSession(database.db, workspace, options.all, controller.signal);
            if (!session) return;
            workspace = await resolveWorkspaceRoot(session.cwd!, controller.signal);
        } else session = await selectWorkspaceSession(database.db, workspace, options.createNew);
        controller.signal.throwIfAborted();
        const { logger } = await import("../../server/src/lib/logger");
        logger.level = "silent";
        const { startServer } = await import("@myagent/server");
        const token = randomBytes(32).toString("hex");
        // O token permanece apenas nesta execução e é entregue diretamente à CUI.
        server = await startServer({ port: 0, token, workspace, sessionId: session.id, onLockLost: interrupt, signal: controller.signal });
        const { startCui } = await import("@myagent/cui");
        cui = await startCui({ apiUrl: server.url, token, workspace, sessionId: session.id, signal: controller.signal, dockerAvailable: server.dockerAvailable });
        await cui.closed;
    } finally {
        interrupt();
        cui?.close();
        try { await server?.stop(); }
        finally { await closeDatabase(); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
    }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "Não foi possível iniciar o My-Code-Agent."); process.exitCode = 1; });
