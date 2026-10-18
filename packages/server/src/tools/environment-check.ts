import { tool } from "ai";
import { z } from "zod";
import { resolveSafePath } from "../utils/path";

export function createEnvironmentCheckTool(cwd: string) {
    return tool({
        description: "Diagnóstico passivo do runtime do servidor e configuração declarada da sandbox. Não executa processos, não lê .env nem revela variáveis/credenciais. Não comprova Docker, ferramentas ou dependências disponíveis na imagem.",
        inputSchema: z.object({}),
        execute: async (_input, { abortSignal }) => {
            abortSignal?.throwIfAborted(); await resolveSafePath(cwd, "."); abortSignal?.throwIfAborted();
            const configured = Boolean(process.env.MYAGENT_SANDBOX_IMAGE);
            return { server: { platform: process.platform, arch: process.arch, bun: Bun.version, nodeCompatibility: process.versions.node },
                workspaceAccessible: true, sandbox: { configured, verified: false, network: false, hostExecution: false,
                    dependenciesVerified: false, nextStep: configured ? "Execute uma verificação na sandbox; runtime do servidor não comprova runtime da imagem." : "Configure MYAGENT_SANDBOX_IMAGE com imagem local de confiança antes de executar processos." } };
        },
    });
}
