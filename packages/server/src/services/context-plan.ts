import type { Mode } from "@myagent/database/enums";
import { COMPACT_CONTEXT_THRESHOLD } from "@myagent/shared";
import type { ToolSet } from "ai";
import type { ToolSecurityOptions } from "../security/tool-policy";
import type { ResolvedModel } from "../lib/providers/registry";
import { CHATGPT_CONTEXT_OPTIONS } from "../lib/providers/chatgpt";
import { ANTHROPIC_PROVIDER_OPTIONS } from "../lib/providers/anthropic";
import { OPENAI_PROVIDER_OPTIONS } from "../lib/providers/openai";
import { GOOGLE_PROVIDER_OPTIONS } from "../lib/providers/google";
import { resolveContextWindow } from "../lib/context-window";
import { ProjectInstructions } from "../lib/project-instructions";
import { isDockerAvailable } from "../security/sandbox";
import { createTools } from "../tools";
import { buildSystemPrompt } from "../prompts";
import { contextBudget } from "./session-context";

const ESSENTIAL_TOOLS = new Set(["read_file", "read_files", "list_directory", "glob", "grep", "edit_file", "write_file", "apply_patch", "git_status", "git_diff", "git_commit", "bash"]);
export function applyContextToolProfile(tools: ToolSet, contextWindow: number): ToolSet {
    return contextWindow < COMPACT_CONTEXT_THRESHOLD ? Object.fromEntries(Object.entries(tools).filter(([name]) => ESSENTIAL_TOOLS.has(name))) : tools;
}
export async function prepareGenerationContext(params: {
    modelId: string; cwd: string | null; mode: Mode; sessionId: string; signal?: AbortSignal;
    resolvedModel?: Pick<ResolvedModel, "provider" | "contextWindow" | "providerOptions" | "toolOptions">;
    instructions?: ProjectInstructions; security?: ToolSecurityOptions; maxToolCalls?: number;
    createTools?: (cwd: string, mode: Mode, sessionId: string, security: ToolSecurityOptions, instructions?: ProjectInstructions) => ToolSet;
}) {
    params.signal?.throwIfAborted();
    const window = resolveContextWindow(params.modelId, params.resolvedModel);
    const compact = window.contextWindow < COMPACT_CONTEXT_THRESHOLD;
    const instructions = params.instructions ?? (params.cwd ? new ProjectInstructions(params.cwd) : undefined);
    const defaults = params.modelId.startsWith("chatgpt:") ? CHATGPT_CONTEXT_OPTIONS : {
        providerOptions: [ANTHROPIC_PROVIDER_OPTIONS, OPENAI_PROVIDER_OPTIONS, GOOGLE_PROVIDER_OPTIONS].find(map => Object.hasOwn(map, params.modelId))?.[params.modelId], toolOptions: undefined,
    };
    const options = params.resolvedModel ?? defaults;
    const baseTools = params.cwd ? applyContextToolProfile((params.createTools ?? createTools)(params.cwd, params.mode, params.sessionId, params.security ?? {}, instructions), window.contextWindow) : undefined;
    const tools = baseTools && options.toolOptions ? Object.fromEntries(Object.entries(baseTools).map(([name, definition]) => [name, { ...definition, providerOptions: options.toolOptions }])) : baseTools;
    const projectInstructions = await instructions?.root(params.signal);
    const system = buildSystemPrompt({ cwd: params.cwd, mode: params.mode, availableTools: Object.keys(tools ?? {}), sandboxConfigured: params.security?.sandboxAvailable ?? isDockerAvailable(), maxToolCalls: params.maxToolCalls, projectInstructions,
        contextNote: `Janela de contexto: ${window.contextWindow} tokens${window.contextWindowEstimated ? " (estimada; configure contextWindow se souber a capacidade real)" : " (catálogo)"}. Perfil ${compact ? "compacto: somente ferramentas essenciais da lista" : "completo"}.`,
    });
    const budget = await contextBudget(window.contextWindow, system, tools, options.providerOptions, window.contextWindowEstimated);
    return { window, tools, system, budget, compact };
}
