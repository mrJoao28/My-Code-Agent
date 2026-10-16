import { mkdir, lstat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client, type Config, type Transaction } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { myagentHome } from "@myagent/shared/home";
import { PrismaClient } from "../generated/prisma/client";
import { runMigrations } from "./migrations";

export class LocalAdapter extends PrismaLibSql {
    constructor(config: Config, private readonly sharedClient?: Client) { super(config); }
    override createClient(config: Config) {
        const client = this.sharedClient ?? createClient(config);
        // O adapter serializa as operações enquanto uma transação está ativa.
        // Reusar a conexão evita o handle nativo destacado por client.transaction().
        client.transaction = async (mode = "write") => {
            await client.execute(mode === "read" || mode === "deferred" ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE");
            let closed = false;
            const check = () => { if (closed) throw new Error("Transação local encerrada."); };
            const finish = async (sql: string) => { if (closed) return; try { await client.execute(sql); } finally { closed = true; } };
            const transaction: Transaction = {
                get closed() { return closed; },
                execute: async (...args: Parameters<typeof client.execute>) => { check(); return client.execute(...args); },
                batch: async statements => {
                    check();
                    const results = [];
                    for (const statement of statements) results.push(await client.execute(Array.isArray(statement) ? { sql: statement[0], args: statement[1] ?? [] } : statement));
                    return results;
                },
                executeMultiple: async () => { throw new Error("Scripts SQL devem ser executados pelo runner de migrations."); },
                commit: () => finish("COMMIT"),
                rollback: () => finish("ROLLBACK"),
                close: () => { void finish("ROLLBACK").catch(() => {}); },
            };
            return transaction;
        };
        return client;
    }
    override async connect() {
        const connection = await super.connect();
        for (const sql of ["PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=5000", "PRAGMA foreign_keys=ON"]) {
            await connection.executeRaw({ sql, args: [], argTypes: [] });
        }
        return connection;
    }
}

export async function openDatabase(options: { home?: string; url?: string } = {}) {
    const home = options.home ?? myagentHome();
    if (!options.url) {
        await mkdir(home, { recursive: true, mode: 0o700 });
        if ((await lstat(home)).isSymbolicLink()) throw new Error("Diretório do banco não pode ser um link.");
        try {
            const info = await lstat(join(home, "myagent.db"));
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Arquivo do banco inseguro.");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const url = options.url ?? pathToFileURL(join(home, "myagent.db")).href;
    if (!url.startsWith("file:") && url !== ":memory:") throw new Error("O banco do My-Code-Agent deve ser SQLite local.");
    const client = createClient({ url });
    const prisma = new PrismaClient({ adapter: new LocalAdapter({ url }, client) });
    try {
        await client.execute("PRAGMA journal_mode=WAL");
        await client.execute("PRAGMA busy_timeout=5000");
        await client.execute("PRAGMA foreign_keys=ON");
        await runMigrations(client);
        await prisma.$connect();
        if (!options.url && process.platform !== "win32") await chmod(join(home, "myagent.db"), 0o600);
    } catch (error) {
        client.close();
        await prisma.$disconnect();
        throw new Error("Não foi possível abrir o banco local do My-Code-Agent.", { cause: error });
    }
    return { db: prisma, client, url, async close() { await prisma.$disconnect(); client.close(); } };
}

let active: Awaited<ReturnType<typeof openDatabase>> | undefined;
let opening: Promise<Awaited<ReturnType<typeof openDatabase>>> | undefined;
export async function initializeDatabase(options?: Parameters<typeof openDatabase>[0]) {
    if (active) return active;
    return opening ??= openDatabase(options).then(database => active = database).finally(() => { opening = undefined; });
}
export async function closeDatabase() {
    if (opening) await opening;
    const current = active;
    active = undefined;
    await current?.close();
}
// Os serviços podem importar o cliente sem abrir o banco ou acessar o home.
export const db = new Proxy({} as PrismaClient, {
    get(_target, key) {
        if (!active) throw new Error("Banco não inicializado; chame initializeDatabase primeiro.");
        const value = Reflect.get(active.db, key);
        return typeof value === "function" ? value.bind(active.db) : value;
    },
});
