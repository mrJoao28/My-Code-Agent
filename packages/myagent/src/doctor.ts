import { openDatabase } from "@myagent/database";
import { myagentHome } from "@myagent/shared/home";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkDocker, imagePresent, sandboxImage } from "../../server/src/security/sandbox";
import { getAllModels, getModelApiKeyEnv } from "../../server/src/lib/model-registry";

export async function doctor() {
    console.log(`Bun: ${Bun.version} (requer >= 1.3.13)`);
    if (Bun.semver.order(Bun.version, "1.3.13") < 0) { console.log("Atualize o Bun em https://bun.sh."); process.exitCode = 1; }
    console.log(`Diretório global: ${myagentHome()}`);
    try {
        await mkdir(myagentHome(), { recursive: true, mode: 0o700 });
        const probe = join(myagentHome(), `doctor-${randomUUID()}.tmp`);
        await writeFile(probe, "", { flag: "wx", mode: 0o600 });
        await unlink(probe);
        console.log("Diretório global: gravável.");
    } catch { console.log("Diretório global: sem permissão de escrita; confira MYAGENT_HOME e as permissões."); process.exitCode = 1; }
    try {
        const database = await openDatabase();
        try { console.log("Banco SQLite: aberto e migrado."); }
        finally { await database.close(); }
    } catch { console.log("Banco SQLite: não abriu ou falhou ao migrar. Confira permissões e integridade; não apague o banco automaticamente."); process.exitCode = 1; }
    const docker = await checkDocker();
    console.log(docker ? "Docker: ativo." : "Docker indisponível: comandos desativados. O aplicativo continua disponível.");
    const image = sandboxImage();
    if (docker) {
        try { console.log(await imagePresent(image) ? `Imagem ${image}: presente.` : `Imagem ${image}: ausente; será baixada na primeira execução aprovada.`); }
        catch { console.log(`Imagem ${image}: não foi possível verificar.`); }
    } else console.log(`Imagem ${image}: verificação adiada até o Docker estar ativo.`);
    console.log("Configuração de modelos (valores das chaves são omitidos):");
    try {
        for (const model of getAllModels()) {
            const name = getModelApiKeyEnv(model);
            if (name) console.log(`  ${model.id}: ${name} ${process.env[name] ? "configurada" : "ausente — necessária para usar este modelo"}.`);
            else if (model.provider === "ollama") console.log(`  ${model.id}: Ollama local; configure OLLAMA_BASE_URL se necessário.`);
            else console.log(`  ${model.id}: autenticação pela conta conectada.`);
        }
    } catch { console.log("Não foi possível ler a configuração dos modelos."); process.exitCode = 1; }
}
