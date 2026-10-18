import { tool } from "ai";
import { z } from "zod";
import { runSandboxCommand } from "../security/sandbox";

export function createBashTool(cwd: string, sessionId?: string) {
    return tool({
        description: "Executa diagnóstico/testes em container Docker sem rede e com cópia filtrada somente leitura do projeto. Credenciais e .git não são copiados; dependências locais somente com MYAGENT_SANDBOX_DEPENDENCIES=1. Escritas só em /tmp, descartadas ao sair. Use ferramentas de arquivo para editar o projeto. Requer Docker; não exige aprovação.",
        inputSchema: z.object({ command: z.string().trim().min(1).max(20_000), timeoutMs: z.number().int().positive().max(120_000).optional() }),
        execute: ({ command, timeoutMs }, { abortSignal }) => runSandboxCommand(cwd, command, timeoutMs ?? 30_000, abortSignal, sessionId),
    });
}
