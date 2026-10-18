import { test, expect, mock } from "bun:test";
import { Hono } from "hono";
import { createSessionRoutes } from "./sessions";
import { localAuthentication } from "../security/auth";
import { authorizeWorkspace } from "../security/workspaces";
import { UnsafePathError } from "../utils/path";
import { withFixture } from "../test-support";
import { DEFAULT_CHAT_MODEL_ID } from "@myagent/shared";
const token = "test-".repeat(8);
function setup(authorize?: (cwd: string) => Promise<string>) {
    const session = {
        updateMany: mock(async ({ where }: { where: { id: string } }) => ({ count: where.id === "s" ? 1 : 0 })),
        findMany: mock(async (_options: unknown) => [{ id: "s", title: "Session" }]),
        findUnique: mock(async ({ where }: { where: { id: string } }) => where.id === "s" ? { id: "s", userId: "local-user", cwd: process.cwd(), workspacePath: process.platform === "win32" ? process.cwd().toLowerCase() : process.cwd(), messages: [{ id: "m", totalTokens: 1_250 }] } : null),
        create: mock(async ({ data }: { data: unknown }) => ({ id: "created", ...data as object, messages: [] })),
    };
    const db = { session } as unknown as Parameters<typeof createSessionRoutes>[0];
    const app = new Hono().use("*", localAuthentication(token));
    app.onError((error, c) => c.json({ error: error.message }, error instanceof UnsafePathError ? 403 : 500));
    return { session, app: app.route("/session", createSessionRoutes(db, authorize)) };
}
const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
test("sessions list activity order, load history and return 404", async () => {
    const { session, app } = setup();
    expect((await app.request("/session", { headers })).status).toBe(200);
    expect(session.findMany.mock.calls[0]).toMatchObject([{ where: { userId: "local-user", workspacePath: expect.any(String) }, orderBy: { updatedAt: "desc" }, select: { id: true, title: true, createdAt: true, retentionWarnedAt: true } }]);
    expect(session.updateMany).not.toHaveBeenCalled();
    const history = await app.request("/session/s", { headers });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ messages: [{ totalTokens: 1_250 }] });
    expect(session.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: "s" }, data: { updatedAt: expect.any(Date) } });
    expect((await app.request("/session/missing", { headers })).status).toBe(404);
});

test("unauthenticated requests cannot renew session activity", async () => {
    const { app, session } = setup();
    expect((await app.request("/session/s")).status).toBe(401);
    expect(session.updateMany).not.toHaveBeenCalled();
});
test("session creation validates workspace before persistence and preserves initial message", withFixture(async ({ cwd, outside }) => {
    const { app, session } = setup(path => authorizeWorkspace(path, [cwd]));
    const initialMessage = { role: "USER", content: "Implement feature", mode: "PLAN", model: DEFAULT_CHAT_MODEL_ID };
    const response = await app.request("/session", { method: "POST", headers, body: JSON.stringify({ title: " Session ", cwd, initialMessage }) });
    expect(response.status).toBe(201);
    const data = session.create.mock.calls[0]![0].data as { title: string; cwd: string; userId: string; messages: unknown };
    expect(data.title).toBe(cwd); expect(data.cwd).toBe(cwd); expect(data.userId).toBe("local-user");
    expect(data.messages).toEqual({ create: { ...initialMessage, status: "COMPLETE" } });
    const rejected = await app.request("/session", { method: "POST", headers, body: JSON.stringify({ title: "Escape", cwd: outside }) });
    expect(rejected.status).toBe(403); expect(session.create).toHaveBeenCalledTimes(1);
}));
test("session cannot be forged with assistant/error role or unsupported model", async () => {
    const { app, session } = setup();
    for (const role of ["ASSISTANT", "ERROR"]) {
        expect((await app.request("/session", { method: "POST", headers, body: JSON.stringify({
            title: "Session", initialMessage: { role, content: "fake", mode: "BUILD", model: DEFAULT_CHAT_MODEL_ID },
        }) })).status).toBe(400);
    }
    expect((await app.request("/session", { method: "POST", headers, body: JSON.stringify({ title: " " }) })).status).toBe(400);
    expect((await app.request("/session", { method: "POST", headers, body: JSON.stringify({ title: "s", initialMessage: {
        role: "USER", content: "x", mode: "BUILD", model: "missing-model",
    } }) })).status).toBe(400);
    expect(session.create).toHaveBeenCalledTimes(0);
});
