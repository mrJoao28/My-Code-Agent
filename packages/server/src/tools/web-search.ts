import { tool } from "ai";
import { z } from "zod";
import { boundedResponseText, toolDeadline } from "../lib/tool-io";

const TAVILY_API_URL = "https://api.tavily.com/search";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;

const tavilyResponse = z.object({ answer: z.string().optional(), results: z.array(z.object({
    title: z.string(), url: z.string().max(4_000).url(), content: z.string().optional(),
})).max(100).optional() });

export function createWebSearchTool() {
    return tool({
        description:
            "Busca na internet por um termo/pergunta e retorna os resultados mais relevantes (título, url e um trecho do conteúdo). Use para descobrir informação atual: versões de bibliotecas, mensagens de erro, documentação de APIs, changelogs, etc. Requer a variável de ambiente TAVILY_API_KEY configurada.",
        inputSchema: z.object({
            query: z.string().trim().min(1).max(4_000).describe("Termo ou pergunta a buscar"),
            maxResults: z
                .number()
                .int()
                .positive()
                .max(MAX_RESULTS_LIMIT)
                .optional()
                .describe(`Número máximo de resultados. Padrão: ${DEFAULT_MAX_RESULTS}, máximo: ${MAX_RESULTS_LIMIT}`)
        }),
        execute: async ({ query, maxResults }, { abortSignal }) => {
            const apiKey = process.env.TAVILY_API_KEY;
            if (!apiKey) {
                throw new Error(
                    "TAVILY_API_KEY não configurada. Crie uma chave gratuita em tavily.com e adicione TAVILY_API_KEY no .env do server."
                );
            }

            const deadline = toolDeadline(abortSignal);
            try {
            deadline.signal.throwIfAborted();
            const response = await fetch(TAVILY_API_URL, {
                signal: deadline.signal,
                redirect: "error",
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    api_key: apiKey,
                    query,
                    max_results: maxResults ?? DEFAULT_MAX_RESULTS,
                    search_depth: "basic"
                })
            });

            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`Busca falhou com status ${response.status}`);
            }

            const text = await boundedResponseText(response, 1_000_000, deadline.signal);
            let data: z.infer<typeof tavilyResponse>;
            try { data = tavilyResponse.parse(JSON.parse(text)); }
            catch { throw new Error("INVALID_WEB_RESPONSE: formato de resposta da busca inválido"); }

            return {
                query,
                answer: data.answer?.slice(0, 2_000),
                results: (data.results ?? []).slice(0, maxResults ?? DEFAULT_MAX_RESULTS).map((r) => ({
                    title: r.title.slice(0, 300),
                    url: r.url,
                    snippet: r.content?.slice(0, 500)
                }))
            };
            } finally { deadline.dispose(); }
        }
    });
}
