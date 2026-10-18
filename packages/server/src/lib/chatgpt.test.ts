import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstat, link, mkdir, symlink } from "node:fs/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Hono } from "hono";
import { ChatGPTService } from "./chatgpt";
import { ChatGPTStore } from "./chatgpt-store";
import { boundedJSON } from "./bounded-json";
import { createChatGPTRoutes } from "../routes/chatgpt";

test("ChatGPT is disabled by default and the server rejects login/model refresh without touching credentials or network", withFixture(async ({ root }) => {
    const previous = process.env.MYAGENT_ENABLE_CHATGPT;
    delete process.env.MYAGENT_ENABLE_CHATGPT;
    let fetched = 0;
    const store = new ChatGPTStore(join(root, "disabled.json"));
    const service = new ChatGPTService({ store, fetch: (async () => { fetched++; throw new Error("unreachable"); }) as never });
    try {
        for (const value of [undefined, "0", "true", "yes"]) {
            if (value === undefined) delete process.env.MYAGENT_ENABLE_CHATGPT; else process.env.MYAGENT_ENABLE_CHATGPT = value;
            expect(service.status()).toEqual({ enabled: false, connected: false, accounts: [] });
            expect(service.models()).toEqual([]);
            await expect(service.startLogin()).rejects.toThrow("MYAGENT_ENABLE_CHATGPT=1");
            await expect(service.accessToken("fixture")).rejects.toThrow("desativado");
            expect((await createChatGPTRoutes(service).request("/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
            expect((await createChatGPTRoutes(service).request("/models", { method: "POST" })).status).toBe(403);
        }
        expect(fetched).toBe(0);
        process.env.MYAGENT_ENABLE_CHATGPT = "1";
        expect(service.status().enabled).toBe(true);
    } finally { if (previous === undefined) delete process.env.MYAGENT_ENABLE_CHATGPT; else process.env.MYAGENT_ENABLE_CHATGPT = previous; }
}));
import { localAuthentication } from "../security/auth";
import { withFixture } from "../test-support";

const grant = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const credentials = (expiresAt = Date.now() + 3_600_000) => ({ access: "fixture-access", refresh: "fixture-refresh", id: "fixture-id", expiresAt, scopes: grant.split(" ") });
function save(store: ChatGPTStore, expiresAt?: number) {
    store.write({ hostId: "urn:uuid:fixture", activeId: "oaiapp_fixture", accounts: [{ clientId: "oaiapp_fixture", subject: "fixture-user", label: "fixture@example.test", tokens: credentials(expiresAt), models: [] }] });
}
function runtime(path: string, fetcher: (url: string, init?: RequestInit) => Promise<Response>, verify?: (token: string, clientId: string, nonce?: string) => Promise<Record<string, unknown>>, loginTimeoutMs?: number) {
    let callback!: (request: Request) => Promise<Response>;
    let stopped = 0;
    const store = new ChatGPTStore(path);
    const service = new ChatGPTService({ enabled: () => true, store, fetch: fetcher as typeof fetch, verify, loginTimeoutMs, listen: handler => {
        callback = handler;
        return { redirect: "http://127.0.0.1:1455/auth/callback", stop: () => { stopped++; } };
    } });
    return { service, store, callback: (url: string, headers?: RequestInit["headers"]) => callback(new Request(url, { headers })), stopped: () => stopped };
}
const identity = async (_token: string, _clientId: string, nonce?: string) => ({ sub: "fixture-user", email: "fixture@example.test", nonce });
const returnedTokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", token_type: "Bearer", expires_in: 3600, scope: grant };
function callbackURL(login: { authorizationUrl: string }, extra: Record<string, string> = {}) {
    const authorization = new URL(login.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_fixture", ...extra }).toString();
    return callback.toString();
}

describe("ChatGPT OAuth", () => {
    test("PKCE, callback state/Host, no replay, private persistence and account catalog", withFixture(async ({ root }) => {
        const requests: { url: string; init?: RequestInit }[] = [];
        const app = runtime(join(root, "private", "chatgpt-credentials.json"), async (url, init) => {
            requests.push({ url, init });
            return Response.json(url.endsWith("/models") ? { models: [
                { slug: "fixture-model", display_name: "Fixture model", visibility: "list" },
                { slug: "hidden", display_name: "Hidden", visibility: "hide" },
            ] } : returnedTokens);
        }, identity);
        const login = await app.service.startLogin();
        const authorization = new URL(login.authorizationUrl);
        expect(authorization.origin).toBe("https://auth.openai.com");
        expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
        expect(authorization.searchParams.get("scope")).toBe(grant);
        const callback = callbackURL(login);
        expect((await app.callback(callbackURL(login, { state: "forged" }))).status).toBe(400);
        expect((await app.callback(callback, { Host: "attacker.example" })).status).toBe(400);
        expect(requests).toHaveLength(0);
        expect((await app.callback(callback)).status).toBe(200);
        expect((await app.callback(callback)).status).toBe(400);
        expect(requests).toHaveLength(1);
        const form = requests[0]!.init!.body as URLSearchParams;
        expect(form.get("client_id")).toBe("oaiapp_fixture");
        expect(form.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
        expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge")!);
        expect(app.service.loginStatus(login.id).status).toBe("complete");
        expect(app.stopped()).toBe(1);
        const models = await app.service.refreshModels();
        expect(models.map(model => model.id)).toEqual(["chatgpt:fixture-model"]);
        expect(new ChatGPTService({ enabled: () => true, store: app.store }).models()).toEqual(models);
        expect(JSON.stringify(app.service.status())).not.toContain("fixture-access");
        expect(JSON.stringify(app.service.status())).not.toContain("fixture-refresh");
        if (process.platform !== "win32") expect((await lstat(app.store.path)).mode & 0o077).toBe(0);
        const again = await app.service.startLogin("oaiapp_fixture");
        const next = new URL(again.authorizationUrl);
        expect(next.searchParams.get("ext_agent_host_id")).toBe(authorization.searchParams.get("ext_agent_host_id"));
        expect(next.searchParams.get("client_id")).toBe("oaiapp_fixture");
        expect(next.searchParams.has("agent_name_hint")).toBe(false);
        expect(next.searchParams.has("id_token_hint")).toBe(false);
        expect((await app.callback(callbackURL(again, { client_id: "different" }))).status).toBe(400);
        expect(app.service.status().connected).toBe(true);
    }));

    test("validates signed identity issuer, audience, nonce and signature before saving credentials", withFixture(async ({ root }) => {
        const { publicKey, privateKey } = await generateKeyPair("RS256");
        const other = await generateKeyPair("RS256");
        const jwk = { ...await exportJWK(publicKey), kid: "fixture" };
        for (const failure of ["none", "issuer", "audience", "nonce", "signature", "expired", "scopes"]) {
            let nonce = "";
            const app = runtime(join(root, failure, "chatgpt-credentials.json"), async url => {
                if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
                if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
                const id = await new SignJWT({ nonce: failure === "nonce" ? "wrong" : nonce })
                    .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setSubject("fixture-user")
                    .setIssuer(failure === "issuer" ? "https://attacker.example" : "https://auth.openai.com")
                    .setAudience(failure === "audience" ? "wrong" : "oaiapp_fixture")
                    .setIssuedAt().setExpirationTime(failure === "expired" ? "-1h" : "1h")
                    .sign(failure === "signature" ? other.privateKey : privateKey);
                return Response.json({ ...returnedTokens, id_token: id, scope: failure === "scopes" ? "openid email" : grant });
            });
            const login = await app.service.startLogin();
            nonce = new URL(login.authorizationUrl).searchParams.get("nonce")!;
            expect((await app.callback(callbackURL(login))).status).toBe(failure === "none" ? 200 : 400);
            expect(app.service.status().connected).toBe(failure === "none");
            expect(app.stopped()).toBe(1);
        }
    }), 20_000);

    test("denial and timeout close callback; cancelled exchange cannot activate an account", withFixture(async ({ root }) => {
        let calls = 0;
        const app = runtime(join(root, "chatgpt-credentials.json"), async () => { calls++; return Response.json(returnedTokens); }, identity, 20);
        const denied = await app.service.startLogin();
        expect((await app.callback(callbackURL(denied, { error: "access_denied" }))).status).toBe(400);
        expect(calls).toBe(0);
        const expired = await app.service.startLogin();
        await Bun.sleep(40);
        expect(app.service.loginStatus(expired.id).status).toBe("error");
        expect((await app.callback(callbackURL(expired))).status).toBe(400);
        const cancel = runtime(join(root, "cancel", "chatgpt-credentials.json"), async () => Response.json(returnedTokens), async (_token, _client, nonce) => {
            cancel.service.cancelLogin(); return { sub: "fixture-user", nonce };
        });
        const login = await cancel.service.startLogin();
        expect((await cancel.callback(callbackURL(login))).status).toBe(400);
        expect(cancel.service.status().connected).toBe(false);
    }));

    test("serializes refresh, atomically rotates tokens and revokes on logout without exposing tokens", withFixture(async ({ root }) => {
        let refreshes = 0;
        let revoked = false;
        const app = runtime(join(root, "chatgpt-credentials.json"), async (url, init) => {
            if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
            if (url.endsWith("/revoke")) { revoked = (init!.body as URLSearchParams).get("token") === "replacement-refresh"; return new Response(null, { status: 200 }); }
            refreshes++; await Bun.sleep(10);
            expect((init!.body as URLSearchParams).get("scope")).toBeNull();
            return Response.json({ ...returnedTokens, access_token: "replacement-access", refresh_token: "replacement-refresh" });
        }, identity);
        save(app.store, 0);
        expect(await Promise.all([app.service.accessToken("oaiapp_fixture"), app.service.accessToken("oaiapp_fixture")])).toEqual(["replacement-access", "replacement-access"]);
        expect(refreshes).toBe(1);
        expect(app.store.read().accounts[0]!.tokens!.refresh).toBe("replacement-refresh");
        const signal = app.service.signal("oaiapp_fixture");
        expect(await app.service.logout("oaiapp_fixture")).toEqual({ revoked: true });
        expect(revoked).toBe(true); expect(signal.aborted).toBe(true);
        expect(app.store.read().accounts[0]!.tokens).toBeUndefined();
        expect(app.store.read().accounts[0]!.clientId).toBe("oaiapp_fixture");
        await expect(app.service.accessToken("oaiapp_fixture")).rejects.toThrow();
    }));

    test("switching accounts never merges equal emails and remote logout failure is explicit", withFixture(async ({ root }) => {
        const app = runtime(join(root, "chatgpt-credentials.json"), async () => { throw new Error("fixture network failure"); }, identity);
        save(app.store);
        const state = app.store.read();
        state.accounts.push({ ...state.accounts[0]!, clientId: "oaiapp_other", subject: "other-subject" }); app.store.write(state);
        const signal = app.service.signal("oaiapp_fixture");
        await app.service.activate("oaiapp_other");
        expect(signal.aborted).toBe(true);
        expect(app.service.status().accounts).toHaveLength(2);
        expect(await app.service.logout("oaiapp_other")).toEqual({ revoked: false });
        expect(app.store.read().accounts[0]!.tokens).toBeDefined();
    }));

    test("all connection endpoints preserve local authentication and return no credentials", withFixture(async ({ root }) => {
        const app = runtime(join(root, "chatgpt-credentials.json"), async () => Response.json(returnedTokens), identity);
        save(app.store);
        const token = "fixture-local-token-32-characters-long";
        const routes = new Hono().use("*", localAuthentication(token)).route("/chatgpt", createChatGPTRoutes(app.service));
        const headers = { Authorization: `Bearer ${token}`, Host: "127.0.0.1:3000" };
        for (const [path, method] of [["", "GET"], ["/login", "POST"], ["/models", "POST"], ["/accounts/oaiapp_fixture", "DELETE"], ["/accounts/oaiapp_fixture/activate", "POST"]]) {
            expect((await routes.request(`http://127.0.0.1:3000/chatgpt${path}`, { method })).status).toBe(401);
            expect((await routes.request(`http://127.0.0.1:3000/chatgpt${path}`, { method, headers: { ...headers, Origin: "https://attacker.example" } })).status).toBe(403);
        }
        const response = await routes.request("http://127.0.0.1:3000/chatgpt", { headers });
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).not.toContain("fixture-access"); expect(body).not.toContain("fixture-refresh"); expect(body).not.toContain("fixture-id");
    }));

    test("credential storage refuses links, ancestor junctions, hard links and overlapping writes", withFixture(async ({ root }) => {
        const path = join(root, "private", "chatgpt-credentials.json");
        const store = new ChatGPTStore(path); save(store);
        const alias = join(root, "alias.json"); await link(path, alias);
        expect(() => store.read()).toThrow();
        expect(() => new ChatGPTStore(alias).read()).toThrow();
        const target = join(root, "target"); await mkdir(target);
        await symlink(target, join(root, "junction"), process.platform === "win32" ? "junction" : "dir");
        expect(() => new ChatGPTStore(join(root, "junction", "chatgpt-credentials.json")).write({ hostId: "urn:uuid:test", accounts: [] })).toThrow();
        const fresh = new ChatGPTStore(join(root, "fresh", "chatgpt-credentials.json"));
        await fresh.locked(async () => { await expect(fresh.locked(async () => {})).rejects.toThrow(); });
        await fresh.locked(async () => {});
    }));

    test("JSON reads enforce limits while streaming and cancel oversized responses", async () => {
        let cancelled = false;
        const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } }));
        await expect(boundedJSON(response, 150)).rejects.toThrow();
        expect(cancelled).toBe(true);
    });

    test("invalid refresh grants clear only the affected credentials and never retry inference", withFixture(async ({ root }) => {
        const app = runtime(join(root, "chatgpt-credentials.json"), async () => Response.json({ error: "invalid_grant" }, { status: 400 }), identity);
        save(app.store, 0);
        await expect(app.service.accessToken("oaiapp_fixture")).rejects.toThrow("Conecte a conta novamente");
        expect(app.service.status().connected).toBe(false);
        expect(app.store.read().accounts[0]!.tokens).toBeUndefined();
    }));

    test("failed first exchange retains the issued registration for a new authorization", withFixture(async ({ root }) => {
        const app = runtime(join(root, "chatgpt-credentials.json"), async () => Response.json({ error: "invalid_grant" }, { status: 400 }), identity);
        const login = await app.service.startLogin();
        expect((await app.callback(callbackURL(login))).status).toBe(400);
        const retry = await app.service.startLogin();
        expect(new URL(retry.authorizationUrl).searchParams.get("client_id")).toBe("oaiapp_fixture");
        expect(app.service.status().connected).toBe(false);
        app.service.cancelLogin(retry.id);
    }));

    test("cancelling refresh aborts network and releases the credential lock", withFixture(async ({ root }) => {
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        let networkSignal: AbortSignal | undefined;
        const app = runtime(join(root, "chatgpt-credentials.json"), async (_url, init) => {
            networkSignal = init?.signal ?? undefined;
            started();
            return new Promise<Response>((_resolve, reject) => {
                if (networkSignal!.aborted) { reject(networkSignal!.reason); return; }
                networkSignal!.addEventListener("abort", () => reject(networkSignal!.reason), { once: true });
            });
        }, identity);
        save(app.store, 0);
        const controller = new AbortController();
        const token = app.service.accessToken("oaiapp_fixture", controller.signal);
        await ready; controller.abort();
        await expect(token).rejects.toThrow();
        expect(networkSignal?.aborted).toBe(true);
        await Bun.sleep(0);
        await app.store.locked(async () => {});
        expect(app.store.read().accounts[0]!.tokens!.refresh).toBe("fixture-refresh");
    }));

    test("real loopback callback listener closes after completing login", withFixture(async ({ root }) => {
        const service = new ChatGPTService({ enabled: () => true, store: new ChatGPTStore(join(root, "chatgpt-credentials.json")),
            fetch: (async () => Response.json(returnedTokens)) as unknown as typeof fetch, verify: identity });
        const login = await service.startLogin();
        try {
            const callback = callbackURL(login);
            expect(new URL(callback).hostname).toBe("127.0.0.1");
            const result = await fetch(callback, { redirect: "error" });
            expect(result.status).toBe(200); await result.text();
            expect(service.loginStatus(login.id).status).toBe("complete");
            await Bun.sleep(10);
            await expect(fetch(callback, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
        } finally { service.cancelLogin(login.id); }
    }));

    test("logout cancels an in-flight refresh and waits for its lock before clearing credentials", withFixture(async ({ root }) => {
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const app = runtime(join(root, "chatgpt-credentials.json"), async (url, init) => {
            if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
            if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
            started();
            return new Promise<Response>((_resolve, reject) => {
                const signal = init!.signal!;
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        }, identity);
        save(app.store, 0);
        const refresh = app.service.accessToken("oaiapp_fixture");
        await ready;
        const logout = app.service.logout("oaiapp_fixture");
        await expect(refresh).rejects.toThrow();
        expect(await logout).toEqual({ revoked: true });
        expect(app.service.status().connected).toBe(false);
        await app.store.locked(async () => {});
    }));
});
