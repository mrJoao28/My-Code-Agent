import type { Mode } from "@myagent/database";
import { SYSTEM_ROLE_TEXT } from "./system";
import { buildCwdNote } from "./coding";
import { PLAN_MODE_TEXT, BUILD_MODE_TEXT } from "./tool-rules";
import { PLAN_WITH_CWD_ADDENDUM } from "./editing";

type SystemPromptParams = {
    cwd: string | null;
    mode: Mode;
    availableTools?: string[];
    sandboxConfigured?: boolean;
};

export function buildSystemPrompt({ cwd, mode, availableTools = [], sandboxConfigured = false }: SystemPromptParams): string {
    const parts: string[] = [];
    parts.push(SYSTEM_ROLE_TEXT);
    parts.push(`CAPACIDADES DESTA GERAÇÃO\nFerramentas disponíveis: ${availableTools.length ? availableTools.join(", ") : "nenhuma"}.\nSandbox declarada: ${sandboxConfigured ? "imagem configurada; funcionamento ainda depende da verificação" : "imagem não configurada; processos indisponíveis"}.\nLimites: 40 chamadas, até três chamadas idênticas e cinco minutos por geração. Resultados truncados não representam todo o conteúdo.`);

    if (cwd) {
        parts.push(buildCwdNote(cwd));
    } else {
        parts.push("Sem workspace: converse e proponha próximos passos; não afirme ter inspecionado ou alterado arquivos.");
    }

    if (mode === "PLAN") {
        parts.push(PLAN_MODE_TEXT);
    } else {
        parts.push(BUILD_MODE_TEXT);
    }

    if (cwd && mode === "PLAN") {
        parts.push(PLAN_WITH_CWD_ADDENDUM);
    }

    return parts.join("\n\n");
}
