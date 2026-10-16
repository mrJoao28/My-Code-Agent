import type { PrismaClient } from "@myagent/database";
import { createInterface } from "node:readline/promises";
import { listWorkspaceSessions } from "../../server/src/services/workspace-sessions";

export async function chooseSession(db: Pick<PrismaClient, "session">, workspace: string, all: boolean, signal: AbortSignal) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
        for (;;) {
            const sessions = await listWorkspaceSessions(db, all ? undefined : workspace);
            sessions.forEach((session, index) => console.log(`${index + 1}. ${session.title} — ${session.updatedAt.toLocaleString("pt-BR")} (${session.id})`));
            if (sessions.length === 0) console.log("Nenhuma sessão encontrada.");
            if (!process.stdin.isTTY) throw new Error("myagent resume exige um terminal interativo para escolher a sessão.");
            const answer = (await input.question(all ? "Número da sessão (Enter para sair): " : "Número da sessão, [t]odas as pastas ou Enter para sair: ", { signal })).trim();
            if (!answer) return null;
            if (!all && answer.toLowerCase() === "t") { all = true; continue; }
            const selected = sessions[Number(answer) - 1];
            if (selected && /^\d+$/.test(answer)) return selected;
            console.log("Escolha um número da lista.");
        }
    } finally { input.close(); }
}
