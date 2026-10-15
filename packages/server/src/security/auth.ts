import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import type { MiddlewareHandler } from "hono";
import { localTokenPath, readLocalToken } from "@myagent/shared/local-auth";

export function ensureLocalToken(path = localTokenPath()): string {
    if (process.env.MYAGENT_API_TOKEN) return readLocalToken(path);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Diretório de autenticação não pode ser um link.");
    try { writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return readLocalToken(path);
}
export function localAuthentication(token: string): MiddlewareHandler {
    const expected = createHash("sha256").update(token).digest();
    return async (c, next) => {
        const host = new URL(c.req.url).hostname;
        if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host) || c.req.header("Origin")
            || c.req.header("Host") && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(c.req.header("Host")!)) return c.json({ error: "Local native clients only" }, 403);
        const authorization = c.req.header("Authorization") ?? "";
        const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!candidate || !timingSafeEqual(expected, createHash("sha256").update(candidate).digest())) return c.json({ error: "Unauthorized" }, 401);
        await next();
    };
}
