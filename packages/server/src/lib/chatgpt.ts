import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JSONWebKeySet } from "jose";
import { z } from "zod";
import { type SupportedChatModelDefinition } from "@myagent/shared";
import { resolveContextWindow } from "./context-window";
import { ChatGPTStore } from "./chatgpt-store";
import type { ChatGPTAccount } from "./chatgpt-store";
import { boundedJSON } from "./bounded-json";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const scopes = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const tokenSchema = z.object({
    access_token: z.string().min(1).max(32_768), refresh_token: z.string().min(1).max(32_768),
    id_token: z.string().min(1).max(32_768).optional(), token_type: z.string().refine(s => s.toLowerCase() === "bearer"),
    expires_in: z.number().positive().max(86_400), scope: z.string().optional(),
});
const label = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 200);
class ChatGPTRequestError extends Error {
    constructor(readonly status: number, readonly code?: string) {
        super(status === 401 || status === 403 || code === "invalid_grant" || code === "invalid_client"
            ? "A sessão ChatGPT expirou ou foi revogada. Conecte a conta novamente."
            : "Não foi possível acessar o ChatGPT. Confira sua conexão e os limites do plano.");
    }
}
type Listener = { redirect: string; stop: () => void };
type Pending = {
    id: string; state: string; nonce: string; verifier: string; redirect: string; clientId?: string;
    status: "waiting" | "exchanging" | "complete" | "error"; message?: string;
    listener: Listener; timer: ReturnType<typeof setTimeout>; controller: AbortController;
};
type Options = {
    enabled?: () => boolean;
    store?: ChatGPTStore; fetch?: typeof fetch;
    listen?: (handler: (request: Request) => Promise<Response>) => Listener;
    verify?: (token: string, clientId: string, nonce?: string) => Promise<JWTPayload>;
    loginTimeoutMs?: number;
};

export class ChatGPTService {
    readonly store: ChatGPTStore;
    private readonly fetcher: typeof fetch;
    private pending?: Pending;
    private refreshing = new Map<string, Promise<string>>();
    private exchange?: Promise<void>;
    private connections = new Map<string, AbortController>();
    constructor(private readonly options: Options = {}) {
        this.store = options.store ?? new ChatGPTStore();
        this.fetcher = options.fetch ?? fetch;
    }
    enabled() { return this.options.enabled?.() ?? (process.env.MYAGENT_ENABLE_CHATGPT ?? "1") === "1"; }
    private requireEnabled() { if (!this.enabled()) throw new Error("Login ChatGPT desativado. Defina MYAGENT_ENABLE_CHATGPT=1 para habilitar."); }
    status() {
        if (!this.enabled()) return { enabled: false, connected: false, accounts: [] };
        const state = this.store.read();
        return {
            enabled: true,
            accounts: state.accounts.map(a => ({ id: a.clientId, label: a.label, connected: Boolean(a.tokens), active: a.clientId === state.activeId })),
            connected: state.accounts.some(a => a.clientId === state.activeId && a.tokens),
        };
    }
    models(): SupportedChatModelDefinition[] {
        if (!this.enabled()) return [];
        const state = this.store.read();
        const account = state.accounts.find(a => a.clientId === state.activeId);
        if (!account?.tokens) return [];
        return account.models.map(m => ({ id: `chatgpt:${m.slug}`, displayName: m.name, provider: "chatgpt", ...resolveContextWindow(`chatgpt:${m.slug}`), pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } }));
    }
    activeId() { return this.enabled() ? this.store.read().activeId : undefined; }
    signal(clientId: string): AbortSignal {
        let controller = this.connections.get(clientId);
        if (!controller) { controller = new AbortController(); this.connections.set(clientId, controller); }
        return controller.signal;
    }
    private interrupt(clientId?: string) {
        if (clientId) { this.connections.get(clientId)?.abort(); this.connections.delete(clientId); }
    }
    private async json(url: string, init: RequestInit = {}, signal?: AbortSignal) {
        this.requireEnabled();
        const response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
        if (!response.ok) {
            let code: string | undefined;
            try {
                const result = z.object({ error: z.string() }).safeParse(await boundedJSON(response, 16_384));
                if (result.success && ["invalid_grant", "invalid_client"].includes(result.data.error)) code = result.data.error;
            } catch { /* Nunca propagar o corpo de erro do endpoint de credenciais. */ }
            throw new ChatGPTRequestError(response.status, code);
        }
        return boundedJSON(response);
    }
    private async metadata(signal?: AbortSignal) {
        const value = z.object({ issuer: z.literal(ISSUER), jwks_uri: z.string().url(), revocation_endpoint: z.string().url() })
            .parse(await this.json(`${ISSUER}/.well-known/openid-configuration`, {}, signal));
        for (const endpoint of [value.jwks_uri, value.revocation_endpoint]) {
            const url = new URL(endpoint);
            if (url.origin !== ISSUER || url.username || url.password) throw new Error("Endpoint de autenticação ChatGPT inválido.");
        }
        return value;
    }
    private async verify(token: string, clientId: string, nonce?: string, signal?: AbortSignal) {
        let payload: JWTPayload;
        if (this.options.verify) payload = await this.options.verify(token, clientId, nonce);
        else {
            const metadata = await this.metadata(signal);
            const keys = await this.json(metadata.jwks_uri, {}, signal) as JSONWebKeySet;
            ({ payload } = await jwtVerify(token, createLocalJWKSet(keys), {
                issuer: ISSUER, audience: clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp", ...(nonce ? ["nonce"] : [])],
            }));
        }
        if (!payload.sub || nonce && payload.nonce !== nonce) throw new Error("Identidade ChatGPT inválida.");
        return payload;
    }
    private tokens(value: z.infer<typeof tokenSchema>, previous?: ChatGPTAccount["tokens"]) {
        const granted = value.scope?.split(/\s+/) ?? previous?.scopes ?? [];
        if (!granted.includes("chatgpt.tokens.use.direct") || !granted.includes("resource.invoke")) {
            throw new Error("O uso do plano ChatGPT não foi autorizado. Conecte novamente e permita o uso do plano.");
        }
        const id = value.id_token ?? previous?.id;
        if (!id) throw new Error("O ChatGPT não retornou um token de identidade.");
        return { access: value.access_token, refresh: value.refresh_token, id, expiresAt: Date.now() + value.expires_in * 1000, scopes: granted };
    }
    private listen(handler: (request: Request) => Promise<Response>): Listener {
        if (this.options.listen) return this.options.listen(handler);
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024, idleTimeout: 5, fetch: handler,
            error: () => new Response("Falha no login. Volte ao terminal.", { status: 500 }) });
        return { redirect: `http://127.0.0.1:${server.port}/auth/callback`, stop: () => { void server.stop(); } };
    }
    async startLogin(clientId?: string) {
        this.requireEnabled();
        this.cancelLogin();
        await this.exchange?.catch(() => {});
        const state = await this.store.locked(async () => { const value = this.store.read(); this.store.write(value); return value; });
        const account = clientId ? state.accounts.find(a => a.clientId === clientId) : undefined;
        if (clientId && !account) throw new Error("Conta ChatGPT não encontrada.");
        const selectedId = clientId ?? state.pendingClientId;
        const listener = this.listen(request => this.callback(request));
        const pending: Pending = {
            id: randomUUID(), state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"),
            verifier: randomBytes(48).toString("base64url"), redirect: listener.redirect, clientId: selectedId,
            status: "waiting", listener, controller: new AbortController(), timer: undefined!,
        };
        this.pending = pending;
        pending.timer = setTimeout(() => this.finish(pending, "error", "O login expirou. Tente novamente."), this.options.loginTimeoutMs ?? 300_000);
        pending.timer.unref();
        const url = new URL(`${ISSUER}/api/accounts/authorize`);
        url.search = new URLSearchParams({
            client_id: selectedId ?? "dynamic_agent_client", ext_agent_host_id: state.hostId,
            ...(selectedId ? {} : { agent_name_hint: "My-Code-Agent" }), ...(account ? { login_hint: account.label } : {}),
            response_type: "code", redirect_uri: pending.redirect, scope: scopes.join(" "), resource: RESOURCE,
            state: pending.state, nonce: pending.nonce, code_challenge_method: "S256",
            code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"),
        }).toString();
        return { id: pending.id, authorizationUrl: url.toString() };
    }
    loginStatus(id: string) {
        if (this.pending?.id !== id) throw new Error("Tentativa de login não encontrada.");
        return { status: this.pending.status, message: this.pending.message };
    }
    cancelLogin(id?: string) {
        if (this.pending && (!id || this.pending.id === id)) this.finish(this.pending, "error", "Login cancelado.");
    }
    private finish(pending: Pending, status: Pending["status"], message?: string) {
        if (pending.status !== "waiting" && pending.status !== "exchanging") return;
        pending.status = status; pending.message = message;
        clearTimeout(pending.timer); pending.controller.abort(); pending.listener.stop();
    }
    private async callback(request: Request): Promise<Response> {
        const pending = this.pending;
        const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'", Connection: "close" };
        if (!pending || pending.status !== "waiting") return new Response("Login indisponível.", { status: 400, headers });
        const url = new URL(request.url);
        if (request.method !== "GET" || url.origin !== new URL(pending.redirect).origin || url.pathname !== "/auth/callback"
            || request.headers.get("host") && request.headers.get("host") !== new URL(pending.redirect).host || request.url.length > 16_384) {
            return new Response("Callback inválido.", { status: 400, headers });
        }
        const state = url.searchParams.get("state") ?? "";
        if (Buffer.byteLength(state) !== Buffer.byteLength(pending.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
            return new Response("Estado de login inválido.", { status: 400, headers });
        }
        pending.status = "exchanging"; // Consome o callback antes de qualquer await: não permite replay.
        try {
            if (url.searchParams.has("error")) throw new Error("A autorização ChatGPT foi recusada. Tente novamente.");
            const issued = url.searchParams.get("client_id") ?? pending.clientId;
            const code = url.searchParams.get("code");
            if (!issued || issued === "dynamic_agent_client" || issued.length > 200 || !code || code.length > 8192
                || pending.clientId && issued !== pending.clientId) throw new Error("Registro ChatGPT incompleto ou inválido.");
            await Promise.allSettled([...this.refreshing.values()]);
            const exchange = this.store.locked(async () => {
                // A rotação de credenciais, logout e ativação não podem concorrer com a gravação.
                const state = this.store.read();
                const existing = state.accounts.find(a => a.clientId === issued);
                if (!existing) { state.pendingClientId = issued; this.store.write(state); }
                const data = tokenSchema.parse(await this.json(TOKEN_URL, { method: "POST", body: new URLSearchParams({
                    grant_type: "authorization_code", client_id: issued, code, code_verifier: pending.verifier,
                    redirect_uri: pending.redirect, resource: RESOURCE,
                }) }, pending.controller.signal));
                const tokens = this.tokens(data);
                const identity = await this.verify(tokens.id, issued, pending.nonce, pending.controller.signal);
                if (existing && existing.subject !== identity.sub) throw new Error("A identidade retornada não corresponde à conta selecionada.");
                pending.controller.signal.throwIfAborted();
                const account: ChatGPTAccount = { clientId: issued, subject: identity.sub!, label: label(typeof identity.email === "string" ? identity.email : identity.sub!), tokens, models: [] };
                state.accounts = [...state.accounts.filter(a => a.clientId !== issued), account];
                this.interrupt(state.activeId); state.activeId = issued; delete state.pendingClientId; this.store.write(state);
            });
            this.exchange = exchange;
            try { await exchange; } finally { if (this.exchange === exchange) this.exchange = undefined; }
            this.finish(pending, "complete");
            return new Response("ChatGPT conectado. Volte ao My-Code-Agent para escolher um modelo.", { headers });
        } catch (error) {
            const message = error instanceof Error && ["O uso do plano", "A autorização", "Registro ChatGPT", "A identidade"].some(prefix => error.message.startsWith(prefix))
                ? error.message : "Não foi possível concluir o login ChatGPT. Tente novamente.";
            this.finish(pending, "error", message);
            return new Response(message, { status: 400, headers });
        }
    }
    async accessToken(clientId: string, signal?: AbortSignal): Promise<string> {
        this.requireEnabled();
        signal?.throwIfAborted();
        const state = this.store.read();
        const account = state.accounts.find(a => a.clientId === clientId);
        if (state.activeId !== clientId || !account?.tokens) throw new Error("Conecte sua conta ChatGPT para usar esse modelo.");
        if (account.tokens.expiresAt > Date.now() + 60_000) return account.tokens.access;
        let task = this.refreshing.get(clientId);
        if (!task) {
            task = this.store.locked(async () => {
                const current = this.store.read();
                const saved = current.accounts.find(a => a.clientId === clientId);
                if (current.activeId !== clientId || !saved?.tokens) throw new Error("A conta ChatGPT foi desconectada.");
                if (saved.tokens.expiresAt > Date.now() + 60_000) return saved.tokens.access;
                let data: z.infer<typeof tokenSchema>;
                try {
                    data = tokenSchema.parse(await this.json(TOKEN_URL, { method: "POST", body: new URLSearchParams({
                        grant_type: "refresh_token", client_id: clientId, refresh_token: saved.tokens.refresh, resource: RESOURCE,
                    }) }, AbortSignal.any([this.signal(clientId), ...(signal ? [signal] : [])])));
                } catch (error) {
                    if (error instanceof ChatGPTRequestError && (error.status === 401 || error.status === 403 || error.code)) {
                        delete saved.tokens; saved.models = []; delete current.activeId; this.store.write(current); this.interrupt(clientId);
                    }
                    throw error;
                }
                try {
                    if (data.id_token && (await this.verify(data.id_token, clientId, undefined, this.signal(clientId))).sub !== saved.subject) throw new Error("A identidade da sessão ChatGPT mudou.");
                    saved.tokens = this.tokens(data, saved.tokens);
                } catch {
                    delete saved.tokens; saved.models = []; delete current.activeId; this.store.write(current); this.interrupt(clientId);
                    throw new Error("A renovação da sessão ChatGPT não pôde ser validada. Conecte a conta novamente.");
                }
                this.store.write(current);
                return saved.tokens.access;
            }).finally(() => this.refreshing.delete(clientId));
            this.refreshing.set(clientId, task);
        }
        if (!signal) return task;
        return new Promise<string>((resolve, reject) => {
            const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
            signal.addEventListener("abort", abort, { once: true });
            task!.then(token => { signal.removeEventListener("abort", abort); resolve(token); }, error => { signal.removeEventListener("abort", abort); reject(error); });
            if (signal.aborted) abort();
        });
    }
    async refreshModels(signal?: AbortSignal) {
        this.requireEnabled();
        const clientId = this.activeId();
        if (!clientId) return [];
        const token = await this.accessToken(clientId, signal);
        const result = z.object({ models: z.array(z.object({ slug: z.string(), display_name: z.string(), visibility: z.string() })).max(500) })
            .parse(await this.json(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } }, signal));
        const models = result.models.filter(m => m.visibility === "list" && /^[a-zA-Z0-9._:-]{1,200}$/.test(m.slug))
            .map(m => ({ slug: m.slug, name: label(m.display_name) }));
        await this.store.locked(async () => {
            const state = this.store.read();
            const account = state.accounts.find(a => a.clientId === clientId);
            if (state.activeId !== clientId || !account?.tokens) throw new Error("A conta ChatGPT mudou durante a consulta.");
            account.models = models; this.store.write(state);
        });
        return this.models();
    }
    async activate(clientId: string) {
        this.requireEnabled();
        this.cancelLogin();
        await this.exchange?.catch(() => {});
        const previous = this.activeId();
        this.interrupt(previous);
        if (previous) await this.refreshing.get(previous)?.catch(() => {});
        await this.store.locked(async () => {
            const state = this.store.read();
            if (!state.accounts.find(a => a.clientId === clientId)?.tokens) throw new Error("Conecte essa conta novamente.");
            this.interrupt(state.activeId); state.activeId = clientId; this.store.write(state);
        });
    }
    async logout(clientId: string) {
        this.cancelLogin(); this.interrupt(clientId);
        await this.exchange?.catch(() => {});
        await this.refreshing.get(clientId)?.catch(() => {});
        return this.store.locked(async () => {
            const state = this.store.read();
            const account = state.accounts.find(a => a.clientId === clientId);
            if (!account) throw new Error("Conta ChatGPT não encontrada.");
            let revoked = !account.tokens;
            try {
                if (account.tokens && this.enabled()) {
                    const { revocation_endpoint } = await this.metadata();
                    const response = await this.fetcher(revocation_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
                        body: new URLSearchParams({ token: account.tokens.refresh, token_type_hint: "refresh_token", client_id: clientId }) });
                    revoked = response.status === 200; await response.body?.cancel();
                }
            } catch { /* Logout local continua; a UI informa se a revogação remota não foi confirmada. */ }
            delete account.tokens; account.models = [];
            if (state.activeId === clientId) delete state.activeId;
            this.store.write(state); return { revoked };
        });
    }
}
export const chatGPT = new ChatGPTService();
