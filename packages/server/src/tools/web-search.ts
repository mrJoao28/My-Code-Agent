import { tool } from "ai";
import { z } from "zod";

const TAVILY_API_URL = "https://api.tavily.com/search";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;

type TavilyResult = {
    title: string;
    url: string;
    content: string;
};

type TavilyResponse = {
    answer?: string;
    results?: TavilyResult[];
};

export function createWebSearchTool() {
    return tool({
        description:
            "Busca na internet por um termo/pergunta e retorna os resultados mais relevantes (título, url e um trecho do conteúdo). Use para descobrir informação atual: versões de bibliotecas, mensagens de erro, documentação de APIs, changelogs, etc. Requer a variável de ambiente TAVILY_API_KEY configurada.",
        inputSchema: z.object({
            query: z.string().describe("Termo ou pergunta a buscar"),
            maxResults: z
                .number()
                .int()
                .positive()
                .max(MAX_RESULTS_LIMIT)
                .optional()
                .describe(`Número máximo de resultados. Padrão: ${DEFAULT_MAX_RESULTS}, máximo: ${MAX_RESULTS_LIMIT}`)
        }),
        execute: async ({ query, maxResults }) => {
            const apiKey = process.env.TAVILY_API_KEY;
            if (!apiKey) {
                throw new Error(
                    "TAVILY_API_KEY não configurada. Crie uma chave gratuita em tavily.com e adicione TAVILY_API_KEY no .env do server."
                );
            }

            const response = await fetch(TAVILY_API_URL, {
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
                const body = await response.text().catch(() => "");
                throw new Error(`Busca falhou com status ${response.status}: ${body.slice(0, 300)}`);
            }

            const data = (await response.json()) as TavilyResponse;

            return {
                query,
                answer: data.answer,
                results: (data.results ?? []).map((r) => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.content?.slice(0, 500)
                }))
            };
        }
    });
}