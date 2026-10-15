import { tool } from "ai";
import { z } from "zod";
import { runSandboxCommand } from "../security/sandbox";

export function createBashTool(cwd: string) {
    return tool({
        description: "Executa diagnóstico/testes em container Docker sem rede e com cópia filtrada somente leitura do projeto. Credenciais, .git e node_modules não são copiados. Escritas só em /tmp, descartadas ao sair. Use ferramentas de arquivo para editar o projeto. Requer MYAGENT_SANDBOX_IMAGE e aprovação.",
        inputSchema: z.object({ command: z.string().trim().min(1).max(20_000), timeoutMs: z.number().int().positive().max(120_000).optional() }),
        execute: ({ command, timeoutMs }, { abortSignal }) => runSandboxCommand(cwd, command, timeoutMs ?? 30_000, abortSignal),
    });
}
