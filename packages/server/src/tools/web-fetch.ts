import { tool } from "ai";
import { z } from "zod";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupAddress } from "node:dns";
import { lookup } from "dns/promises";
import { checkServerIdentity } from "node:tls";
import { abortable, boundedResponseText, toolDeadline } from "../lib/tool-io";

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

const blocked4 = new BlockList(), blocked6 = new BlockList(), mapped = new BlockList();
// Range equivalente a ::ffff:0:0/96 evita uma falha de check de subnet no Bun 1.3.13.
mapped.addRange("::ffff:0:0", "::ffff:ffff:ffff", "ipv6");
for (const [network, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10],
    ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16], ["2001:db8::", 32], ["ff00::", 8],
] as const) blocked6.addSubnet(network, prefix, "ipv6");
blocked6.addAddress("::1", "ipv6");

export function isDisallowedIp(ip: string): boolean {
    const family = isIP(ip);
    return !family || (family === 4 ? blocked4.check(ip, "ipv4") : (mapped.check(ip, "ipv6") || blocked6.check(ip, "ipv6")));
}
export type PublicAddress = { address: string; family: 4 | 6 };
export type WebFetchDependencies = {
    resolve: (hostname: string) => Promise<LookupAddress[]>;
    request: (url: URL, address: PublicAddress, signal: AbortSignal) => Promise<Response>;
};
async function publicAddress(hostname: string, signal: AbortSignal, resolve: WebFetchDependencies["resolve"]): Promise<PublicAddress> {
    signal.throwIfAborted();
    const host = hostname.replace(/^\[|\]$/g, "");
    let addresses: LookupAddress[];
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else {
        if (host.toLowerCase().replace(/\.$/, "").endsWith(".localhost") || host.toLowerCase().replace(/\.$/, "") === "localhost") throw new Error("Acesso bloqueado: host local.");
        try { addresses = await abortable(resolve(host), signal); }
        catch { signal.throwIfAborted(); throw new Error("Não foi possível resolver o host."); }
    }
    if (!addresses.length || addresses.some(a => isDisallowedIp(a.address) || a.family !== isIP(a.address))) throw new Error("Acesso bloqueado: endereço de rede interno/reservado.");
    const first = addresses[0]!;
    return { address: first.address, family: first.family as 4 | 6 };
}

/** Sem pool/proxy: Host e SNI usam a URL, mas o socket só recebe o IP aprovado. */
export function requestPinned(url: URL, address: PublicAddress, signal: AbortSignal, send = url.protocol === "https:" ? httpsRequest : httpRequest): Promise<Response> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const request = send(url, {
            agent: false, signal, family: address.family, hostname: address.address,
            rejectUnauthorized: true,
            checkServerIdentity: (_host, certificate) => checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ""), certificate),
            servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
            lookup: (_host, options, callback) => {
                if (options.all) callback(null, [address]);
                else callback(null, address.address, address.family);
            },
            headers: { Host: url.host, "User-Agent": "MyCodeAgent/1.0 (+local coding assistant)", "Accept-Encoding": "identity" },
        }, response => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) { request.destroy(new Error("OUTPUT_LIMIT_REACHED: resposta excedeu o limite de bytes")); return; }
                chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("aborted", () => reject(new Error("Resposta HTTP interrompida.")));
            response.on("end", () => {
                const headers = new Headers();
                for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
                const status = response.statusCode ?? 502;
                if (headers.get("content-encoding") && headers.get("content-encoding") !== "identity") { reject(new Error("Codificação de resposta não suportada.")); return; }
                try { resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })); }
                catch (error) { reject(error); }
            });
        });
        request.on("error", reject);
        request.end();
    });
}

async function fetchWithSsrfGuard(initialUrl: string, signal: AbortSignal, sameOriginOnly: boolean, dependencies: WebFetchDependencies): Promise<Response> {
    let currentUrl = initialUrl;

    for (let redirectCount = 0; ; redirectCount++) {
        const parsed = new URL(currentUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Apenas URLs http/https são permitidas");
        }

        if (sameOriginOnly && parsed.origin !== new URL(initialUrl).origin) throw new Error(`Redirecionamento para ${currentUrl}: faça uma nova chamada web_fetch para aprovar esse domínio.`);
        if (parsed.username || parsed.password) throw new Error("URLs com credenciais não são permitidas");
        const address = await publicAddress(parsed.hostname, signal, dependencies.resolve);
        const response = await dependencies.request(parsed, address, signal);

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get("location");

        if (!isRedirect || !location) {
            return response;
        }

        if (redirectCount >= MAX_REDIRECTS) {
            await response.body?.cancel();
            throw new Error(`Muitos redirecionamentos (limite: ${MAX_REDIRECTS})`);
        }

        currentUrl = new URL(location, currentUrl).toString();
        await response.body?.cancel();
    }
}

export function createWebFetchTool(sameOriginOnly = false, dependencies: WebFetchDependencies = { resolve: hostname => lookup(hostname, { all: true }), request: requestPinned }) {
    return tool({
        description: `Busca o conteúdo de uma URL na internet e retorna o texto (HTML é convertido para texto simples). Conteúdo maior que ${MAX_CONTENT_CHARS} caracteres é truncado. Use para ler documentação, changelogs, mensagens de erro específicas, ou qualquer página que o usuário mencionar. Endereços de rede interna/privada (localhost, IPs privados, metadata de nuvem) são bloqueados por segurança.`,
        inputSchema: z.object({
            url: z.string().max(4_000).url().describe("URL completa a ser buscada (deve começar com http:// ou https://)")
        }),
        execute: async ({ url }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal, FETCH_TIMEOUT_MS);

            try {
                const response = await fetchWithSsrfGuard(url, deadline.signal, sameOriginOnly, dependencies);

                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(`Requisição falhou com status ${response.status} ${response.statusText}`);
                }

                const contentType = response.headers.get("content-type") ?? "";
                const raw = await boundedResponseText(response, MAX_RESPONSE_BYTES, deadline.signal);
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
                deadline.dispose();
            }
        }
    });
}
