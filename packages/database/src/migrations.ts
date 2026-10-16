/// <reference path="./sql.d.ts" />
import type { Client } from "@libsql/client";
import baseline from "../prisma/migrations/20261016000000_sqlite_baseline/migration.sql" with { type: "text" };
import workspaceSessions from "../prisma/migrations/20261016010000_workspace_sessions/migration.sql" with { type: "text" };

export const migrations = [{ version: 1, sql: baseline }, { version: 2, sql: workspaceSessions }];

export async function runMigrations(client: Client, steps = migrations): Promise<void> {
    await client.execute("BEGIN IMMEDIATE");
    try {
        const result = await client.execute("PRAGMA user_version");
        let version = Number(result.rows[0]?.user_version ?? 0);
        let script = "";
        if (version > (steps.at(-1)?.version ?? 0)) throw new Error("Banco criado por uma versão mais recente do My-Code-Agent.");
        for (const step of steps) {
            if (step.version <= version) continue;
            if (step.version !== version + 1) throw new Error("Sequência de migrations inválida.");
            script += `\n${step.sql}\n;\nPRAGMA user_version = ${step.version};\n`;
            version = step.version;
        }
        // executeMultiple usa a conexão atual e desfaz a transação em caso de erro.
        // client.transaction() abre outra conexão no driver local e perde :memory:.
        await client.executeMultiple(`${script}\nCOMMIT;`);
    } catch (error) {
        try { await client.execute("ROLLBACK"); } catch { /* O driver pode já ter revertido. */ }
        throw new Error("Não foi possível aplicar as migrations SQLite; alterações revertidas.", { cause: error });
    }
}
