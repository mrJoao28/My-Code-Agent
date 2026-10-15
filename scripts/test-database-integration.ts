import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
// Projeto e volume exclusivos: nunca execute os testes no banco de desenvolvimento.
const project = `myagent-db-test-${randomUUID()}`;
const password = randomBytes(32).toString("hex");
const env = {
    ...process.env,
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: "myagent_test",
    POSTGRES_PORT: "0",
};
const compose = ["docker", "compose", "--project-name", project];

async function run(command: string[], commandEnv = env, capture = false): Promise<string> {
    const child = Bun.spawn(command, {
        cwd, env: commandEnv, stdout: capture ? "pipe" : "inherit", stderr: "inherit",
    });
    const output = capture ? await new Response(child.stdout).text() : "";
    if (await child.exited !== 0) throw new Error(`Falha ao executar ${command[0]} ${command[1]}`);
    return output.trim();
}

let failed = false;
try {
    await run([...compose, "up", "-d", "--wait", "--wait-timeout", "90", "postgres"]);
    const address = await run([...compose, "port", "postgres", "5432"], env, true);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
    if (!match) throw new Error("O banco de testes deve publicar apenas uma porta IPv4 de loopback.");
    const url = `postgresql://myagent:${password}@127.0.0.1:${match[1]}/myagent_test`;
    const testEnv = { ...env, DATABASE_URL: url, MYAGENT_TEST_DATABASE_URL: url };
    await run([process.execPath, "run", "--cwd", "packages/database", "db.deploy"], testEnv);
    await run([process.execPath, "test", "packages/database/src/database.integration.test.ts"], testEnv);
} catch {
    // Não imprimir objetos de erro que possam conter URLs com credenciais.
    console.error("Integração PostgreSQL falhou; consulte a saída do Docker, Prisma ou dos testes acima.");
    failed = true;
} finally {
    try {
        await run([...compose, "down", "--volumes", "--remove-orphans"]);
    } catch {
        console.error(`Não foi possível limpar o projeto de testes ${project}.`);
        failed = true;
    }
}
process.exitCode = failed ? 1 : 0;
