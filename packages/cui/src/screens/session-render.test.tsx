import { expect, test } from "bun:test";



import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";





// Child processes isolate the real HTTP client from mock.module in dialog tests.
if (!process.env.MYAGENT_SESSION_RENDER_CHILD) {
    test("session screen with real providers and simulated API (source and Bun bundle)", async () => {
        const directory = await mkdtemp(resolve(import.meta.dirname, "../../.session-render-"));
        try {
            // Build in a fresh process too: other suites replace modules globally.
            const options = { entrypoints: [import.meta.path], outdir: directory, target: "bun", define: { "process.env.NODE_ENV": JSON.stringify("production") },
                external: ["bun:test", "@opentui/core", "@opentui/react", "react"],
                tsconfig: resolve(import.meta.dirname, "../../tsconfig.json") };
            const builder = Bun.spawn([process.execPath, "-e", "const result = await Bun.build(" + JSON.stringify(options) + "); if (!result.success) { console.error(result.logs); process.exitCode = 1; }"], { stdout: "pipe", stderr: "pipe" });
            const [built, buildOut, buildErr] = await Promise.all([builder.exited, new Response(builder.stdout).text(), new Response(builder.stderr).text()]);
            if (built !== 0) throw new Error(buildOut + buildErr);
            expect(built).toBe(0);
            for (const path of [import.meta.path, resolve(directory, "session-render.test.js")]) {
                const child = Bun.spawn([process.execPath, "test", path], {
                    env: { ...process.env, MYAGENT_SESSION_RENDER_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
                });
                const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
                if (exit !== 0) throw new Error(out + err);
                expect(exit).toBe(0);
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    }, 30_000);
} else {
    const { act } = await import("react");
    const { createMemoryRouter, RouterProvider } = await import("react-router");
    const { testRender } = await import("@opentui/react/test-utils");
    const { RootLayout } = await import("../layouts/root-layout");
    const { RouteError } = await import("../components/route-error");
    const { Session } = await import("./session");
    const { configureApiClient } = await import("../lib/api-client");

    test.each(["done", "error"])("no Git, path with spaces, Docker absent, omitted tools, send and %s", async ending => {
        let send!: (event: object) => void;
        let finish!: () => void;
        const requests: { mode: string; content: string }[] = [];
        const workspace = "C:/fixture/projeto sem git com espaços";
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/session/fixture") return Response.json({ id: "fixture", title: workspace, messages: [] });
            if (url.pathname === "/chat/fixture") {
                requests.push(await req.json() as { mode: string; content: string });
                return new Response(new ReadableStream({ start(controller) {
                    send = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
                    finish = () => controller.close();
                } }), { headers: { "Content-Type": "text/event-stream" } });
            }
            throw new Error("Unexpected fixture request: " + url.pathname);
        } });
        configureApiClient({ apiUrl: server.url.toString(), token: "fixture-token", workspace });
        const router = createMemoryRouter([{ path: "/", element: <RootLayout />, errorElement: <RouteError />, children: [
            { path: "sessions/:id", element: <Session /> },
        ] }], { initialEntries: ["/sessions/fixture"] });
        let ui!: Awaited<ReturnType<typeof testRender>>;
        try {
            await act(async () => { ui = await testRender(<box flexDirection="column" flexGrow={1}>
                <text>Docker indisponível: comandos desativados</text><RouterProvider router={router} />
            </box>, { width: 110, height: 45 }); });
            await ui.waitForFrame(frame => frame.includes(workspace));
            expect(ui.captureCharFrame()).toContain("Docker indisponível");
            await act(async () => { await ui.mockInput.typeText("Mensagem de teste"); });
            await act(async () => { ui.mockInput.pressEnter(); });
            await ui.waitFor(() => requests.length === 1);
            await ui.waitForFrame(frame => frame.includes("Executando em BUILD"));
            // Switching the next mode cannot change the active generation.
            await act(async () => { ui.mockInput.pressTab(); });
            await ui.waitForFrame(frame => frame.includes("Executando em BUILD") && frame.includes("Próxima mensagem: Plan"));
            expect(requests[0]!.mode).toBe("BUILD");
            await act(async () => {
                send({ type: "tool-call", toolCallId: "empty", toolName: "read_file", args: {} });
                send({ type: "tool-result", toolCallId: "empty", toolName: "read_file", result: "" });
                send({ type: "tool-call", toolCallId: "long", toolName: "read_file", args: { path: "arquivo com espaços.ts" } });
                send({ type: "tool-result", toolCallId: "long", toolName: "read_file", result: "saída longa\n".repeat(10_000) });
                send({ type: "text-delta", text: "Resposta simulada recebida" });
            });
            await ui.waitForFrame(frame => frame.includes("Resposta simulada recebida"));
            await act(async () => {
                send(ending === "error" ? { type: "error", message: "Falha de geração simulada" } : { type: "done", messageId: "saved", durationMs: 50 });
                finish();
            });
            await ui.waitForFrame(frame => !frame.includes("Executando em"));
            if (ending === "error") expect(ui.captureCharFrame()).toContain("Falha de geração simulada");
            expect(ui.captureCharFrame()).not.toContain("Text must be created");
            await act(async () => { ui.mockInput.pressCtrlC(); });
        } finally { await act(async () => { ui?.renderer.destroy(); }); router.dispose(); await server.stop(true); }
    });

    test("route exceptions render terminal text and Ctrl+C exits", async () => {
        function Broken(): never { throw new Error("Falha original preservada"); }
        const router = createMemoryRouter([{ path: "/", element: <Broken />, errorElement: <RouteError /> }]);
        let ui!: Awaited<ReturnType<typeof testRender>>;
        let destroyed = false;
        try {
            await act(async () => { ui = await testRender(<RouterProvider router={router} />, { onDestroy: () => { destroyed = true; } }); });
            await ui.waitForFrame(frame => frame.includes("Falha original preservada"));
            expect(ui.captureCharFrame()).not.toContain("Text must be created");
            await act(async () => { ui.mockInput.pressCtrlC(); });
            expect(destroyed).toBe(true);
        } finally { await act(async () => { ui?.renderer.destroy(); }); router.dispose(); }
    });

    test("session mode is derived independently from the last relevant persisted message", async () => {
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
            const id = new URL(req.url).pathname.split("/").at(-1)!;
            return Response.json({ id, title: "Session " + id, messages: [
                { id: id + "reply", role: "ASSISTANT", content: "Histórico", mode: id === "plan" ? "PLAN" : "BUILD", model: "fixture", parts: [{ type: "text", text: "Histórico" }], status: "COMPLETED" },
                { id: id + "error", role: "ERROR", content: "Erro posterior", mode: "BUILD", model: "fixture" },
            ] });
        } });
        configureApiClient({ apiUrl: server.url.toString(), token: "fixture", workspace: "C:/fixture" });
        const router = createMemoryRouter([{ path: "/", element: <RootLayout />, errorElement: <RouteError />, children: [{ path: "sessions/:id", element: <Session /> }] }], { initialEntries: ["/sessions/plan"] });
        let ui!: Awaited<ReturnType<typeof testRender>>;
        try {
            await act(async () => { ui = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 }); });
            await ui.waitForFrame(frame => frame.includes("Session plan") && frame.includes("Plan >"));
            await act(async () => { await router.navigate("/sessions/build"); });
            await ui.waitForFrame(frame => frame.includes("Session build") && frame.includes("Build >"));
            await act(async () => { await router.navigate("/sessions/plan"); });
            await ui.waitForFrame(frame => frame.includes("Session plan") && frame.includes("Plan >"));
            expect(ui.captureCharFrame()).toContain("Erro posterior");
        } finally { await act(async () => { ui?.renderer.destroy(); }); router.dispose(); await server.stop(true); }
    });
}
