import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { lstat, link, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localAuthentication, ensureLocalToken } from "./auth";
import { readLocalToken, validateToken } from "@myagent/shared/local-auth";
import { withFixture } from "../test-support";

const token = "test-".repeat(8);
function app() {
    return new Hono().use("*", localAuthentication(token))
        .use("*", bodyLimit({ maxSize: 1024 }))
        .all("*", c => c.json({ ok: true }));
}
const headers = { Authorization: "Bearer " + token };
describe("Local API authentication", () => {
    test.each(["/session", "/models", "/chat/s1", "/permissions/s1/a1"])("requires a token on %s", async path => {
        expect((await app().request(path)).status).toBe(401);
        expect((await app().request(path, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
        expect((await app().request(path, { headers })).status).toBe(200);
    });
    test("rejects browser origins, foreign hostnames and DNS rebinding Host", async () => {
        expect((await app().request("/", { headers: { ...headers, Origin: "https://attacker.example" } })).status).toBe(403);
        expect((await app().request("http://attacker.example/", { headers })).status).toBe(403);
        expect((await app().request("/", { headers: { ...headers, Host: "attacker.example" } })).status).toBe(403);
        expect((await app().request("http://127.0.0.1/", { headers })).status).toBe(200);
    });
    test("rejects oversized request body after authentication", async () => {
        expect((await app().request("/", { method: "POST", headers, body: "x".repeat(2048) })).status).toBe(413);
    });
    test("generates a private stable local token", withFixture(async ({ root }) => {
        const previous = process.env.MYAGENT_API_TOKEN; delete process.env.MYAGENT_API_TOKEN;
        try {
            const path = join(root, "auth", "api-token");
            const first = ensureLocalToken(path);
            expect(first).toHaveLength(64);
            expect(ensureLocalToken(path)).toBe(first);
            expect(readLocalToken(path)).toBe(first);
            if (process.platform !== "win32") expect((await lstat(path)).mode & 0o077).toBe(0);
        } finally {
            if (previous === undefined) delete process.env.MYAGENT_API_TOKEN; else process.env.MYAGENT_API_TOKEN = previous;
        }
    }));
    test("rejects weak tokens and token hard links", withFixture(async ({ root }) => {
        expect(() => validateToken("short")).toThrow();
        expect(() => validateToken("x".repeat(32) + "\n")).toThrow();
        const previous = process.env.MYAGENT_API_TOKEN; delete process.env.MYAGENT_API_TOKEN;
        try {
            await writeFile(join(root, "original"), token, { mode: 0o600 });
            await link(join(root, "original"), join(root, "alias"));
            expect(() => readLocalToken(join(root, "alias"))).toThrow();
        } finally {
            if (previous === undefined) delete process.env.MYAGENT_API_TOKEN; else process.env.MYAGENT_API_TOKEN = previous;
        }
    }));
});
