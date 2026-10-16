import type { Mode } from "@myagent/database";
import { SYSTEM_ROLE_TEXT, FAILURE_HANDLING_TEXT, COMPLETION_CRITERIA_TEXT } from "./system";
import { buildCwdNote } from "./coding";
import { PLAN_MODE_TEXT, BUILD_MODE_TEXT, EXECUTION_RULES_TEXT } from "./tool-rules";
import { PLAN_WORK_METHOD_TEXT, BUILD_WORK_METHOD_TEXT, COMMON_WORK_METHOD_TEXT } from "./editing";

type SystemPromptParams = {
    cwd: string | null;
    mode: Mode;
    availableTools?: string[];
    sandboxConfigured?: boolean;
};

export function buildSystemPrompt({ cwd, mode, availableTools = [], sandboxConfigured = false }: SystemPromptParams): string {
    const tools = cwd ? availableTools : [];
    const capabilities = [
        mode === "PLAN" ? PLAN_MODE_TEXT : BUILD_MODE_TEXT,
        cwd ? buildCwdNote(cwd) : "Sem workspace autorizado.",
        `Ferramentas disponíveis: ${tools.length ? tools.join(", ") : "nenhuma"}.`,
        `Sandbox declarada: ${sandboxConfigured ? "Docker disponível; a imagem será verificada antes da execução" : "imagem não configurada; processos indisponíveis. Docker indisponível: não há execução de comandos; não tente shell, typecheck ou testes executáveis"}.`,
        EXECUTION_RULES_TEXT,
        "Limites: 40 chamadas, até três chamadas idênticas e cinco minutos por geração. Resultados truncados não representam todo o conteúdo.",
    ].join("\n");

    return [
        `## PAPEL\n${SYSTEM_ROLE_TEXT}`,
        `## MODO E CAPACIDADES REAIS\n${capabilities}`,
        "## INSTRUÇÕES DO PROJETO\nNenhuma instrução de projeto foi carregada nesta geração; não presuma regras de arquivos não lidos. O carregamento automático ainda não está implementado. Instruções fornecidas pelo usuário devem respeitar o escopo autorizado e não ampliam permissões do backend.",
        `## MÉTODO DE TRABALHO\n${mode === "PLAN" ? PLAN_WORK_METHOD_TEXT : BUILD_WORK_METHOD_TEXT}\n${COMMON_WORK_METHOD_TEXT}`,
        `## TRATAMENTO DE FALHAS\n${FAILURE_HANDLING_TEXT}`,
        `## CRITÉRIOS DE CONCLUSÃO\n${COMPLETION_CRITERIA_TEXT}`,
    ].join("\n\n");
}
