import { tool } from "ai";
import { z } from "zod";

const MAX_CONTENT_CHARS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB

function stripHtml(html: string): string {
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ");

    text = text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function createWebFetchTool() {
    return tool({
        description: `Busca o conteúdo de uma URL na internet e retorna o texto (HTML é convertido para texto simples). Conteúdo maior que ${MAX_CONTENT_CHARS} caracteres é truncado. Use para ler documentação, changelogs, mensagens de erro específicas, ou qualquer página que o usuário mencionar.`,
        inputSchema: z.object({
            url: z.string().url().describe("URL completa a ser buscada (deve começar com http:// ou https://)")
        }),
        execute: async ({ url }) => {
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error("Apenas URLs http/https são permitidas");
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

            try {
                const response = await fetch(url, {
                    signal: controller.signal,
                    redirect: "follow",
                    headers: {
                        "User-Agent": "MyCodeAgent/1.0 (+local coding assistant)"
                    }
                });

                if (!response.ok) {
                    throw new Error(`Requisição falhou com status ${response.status} ${response.statusText}`);
                }

                const contentType = response.headers.get("content-type") ?? "";
                const buffer = await response.arrayBuffer();

                if (buffer.byteLength > MAX_RESPONSE_BYTES) {
                    throw new Error(
                        `Resposta tem ${buffer.byteLength} bytes, acima do limite de ${MAX_RESPONSE_BYTES} bytes`
                    );
                }

                const raw = Buffer.from(buffer).toString("utf-8");
                const isHtml = contentType.includes("text/html");
                let content = isHtml ? stripHtml(raw) : raw;

                let truncated = false;
                if (content.length > MAX_CONTENT_CHARS) {
                    content = content.slice(0, MAX_CONTENT_CHARS);
                    truncated = true;
                }

                return {
                    url,
                    contentType,
                    content,
                    truncated
                };
            } finally {
                clearTimeout(timeout);
            }
        }
    });
}