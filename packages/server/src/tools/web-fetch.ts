import { tool } from "ai";
import { z } from "zod";
import { isIP } from "net";
import { lookup } from "dns/promises";

const MAX_CONTENT_CHARS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_REDIRECTS = 5;

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

/**
 * BUGFIX (SSRF): a versão anterior desta tool passava a URL do usuário
 * direto para `fetch()` sem nenhuma validação de destino além do
 * protocolo (http/https). Isso permitia que o modelo (por instrução do
 * usuário, ou por uma injeção de prompt vinda de uma página já
 * buscada) fizesse a própria aplicação disparar requisições para:
 *   - a rede interna/loopback (ex: http://localhost:3000/session,
 *     expondo o histórico de chat de outras sessões);
 *   - endereços link-local usados por provedores de nuvem para expor
 *     credenciais da instância (ex: http://169.254.169.254/...).
 *
 * Como as demais tools do projeto já bloqueiam ações perigosas de
 * propósito (ex: `bash` bloqueia `curl`/`wget`/`ssh` explicitamente),
 * era uma inconsistência deixar a própria tool de fetch HTTP do
 * agente sem nenhuma barreira equivalente.
 *
 * A validação abaixo resolve o hostname via DNS e rejeita qualquer
 * endereço IPv4/IPv6 privado, loopback, link-local ou reservado — e é
 * reaplicada a cada redirecionamento, já que seguir redirects sem
 * revalidar permitiria contornar a checagem inicial (DNS rebinding /
 * redirect para um alvo interno).
 */
function isDisallowedIPv4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];

    if (a === 0) return true; // "esta" rede
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / metadata de nuvem
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reservado
    return false;
}

function isDisallowedIPv6(ip: string): boolean {
    const normalized = ip.toLowerCase();

    if (normalized === "::1") return true; // loopback
    if (normalized === "::") return true; // unspecified
    if (normalized.startsWith("fe80:")) return true; // link-local
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA (fc00::/7)

    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — valida o IPv4 embutido
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isDisallowedIPv4(mapped[1]!);

    return false;
}

function isDisallowedIp(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) return isDisallowedIPv4(ip);
    if (version === 6) return isDisallowedIPv6(ip);
    return true; // não reconhecido como IP válido — não arrisca
}

async function assertPublicHostname(hostname: string): Promise<void> {
    const ipVersion = isIP(hostname);
    if (ipVersion) {
        if (isDisallowedIp(hostname)) {
            throw new Error(`Acesso bloqueado: "${hostname}" é um endereço de rede interno/reservado.`);
        }
        return;
    }

    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
        throw new Error(`Acesso bloqueado: "${hostname}" resolve para a máquina local.`);
    }

    let addresses: { address: string }[];
    try {
        addresses = await lookup(hostname, { all: true });
    } catch {
        throw new Error(`Não foi possível resolver o host "${hostname}".`);
    }

    if (addresses.length === 0 || addresses.some((a) => isDisallowedIp(a.address))) {
        throw new Error(`Acesso bloqueado: "${hostname}" resolve para um endereço de rede interno/reservado.`);
    }
}

async function fetchWithSsrfGuard(initialUrl: string, signal: AbortSignal): Promise<Response> {
    let currentUrl = initialUrl;

    for (let redirectCount = 0; ; redirectCount++) {
        const parsed = new URL(currentUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Apenas URLs http/https são permitidas");
        }

        await assertPublicHostname(parsed.hostname);

        const response = await fetch(currentUrl, {
            signal,
            redirect: "manual",
            headers: {
                "User-Agent": "MyCodeAgent/1.0 (+local coding assistant)"
            }
        });

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get("location");

        if (!isRedirect || !location) {
            return response;
        }

        if (redirectCount >= MAX_REDIRECTS) {
            throw new Error(`Muitos redirecionamentos (limite: ${MAX_REDIRECTS})`);
        }

        currentUrl = new URL(location, currentUrl).toString();
    }
}

export function createWebFetchTool() {
    return tool({
        description: `Busca o conteúdo de uma URL na internet e retorna o texto (HTML é convertido para texto simples). Conteúdo maior que ${MAX_CONTENT_CHARS} caracteres é truncado. Use para ler documentação, changelogs, mensagens de erro específicas, ou qualquer página que o usuário mencionar. Endereços de rede interna/privada (localhost, IPs privados, metadata de nuvem) são bloqueados por segurança.`,
        inputSchema: z.object({
            url: z.string().url().describe("URL completa a ser buscada (deve começar com http:// ou https://)")
        }),
        execute: async ({ url }) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

            try {
                const response = await fetchWithSsrfGuard(url, controller.signal);

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