import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../providers/theme";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { DialogProvider } from "../providers/dialog";
import { ToastProvider } from "../providers/toast";
import { PromptConfigProvider } from "../providers/prompt-config";
import { SessionShell } from "./session-shell";
import { BotMessage, ErrorMessage, UserrMessage } from "./messages";
import type { ClientMessagePart } from "../hooks/use-chat";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const cases: { name: string; parts: ClientMessagePart[]; loading?: boolean }[] = [
    { name: "compact context warning", parts: [{ type: "context-warning", contextWindow: 16384, estimated: true, toolCount: 10, message: "Perfil compacto: janela estimada de 16384 tokens" }] },
    { name: "waiting", parts: [], loading: true },
    ...["partial reply", "", "   ", "\n\n", "Olá 👋 漢字"].map(text => ({ name: `text ${JSON.stringify(text)}`, parts: [{ type: "text" as const, text }], loading: true })),
    { name: "reasoning", parts: [{ type: "reasoning", text: "Investigando" }], loading: true },
    { name: "pending tool", parts: [{ type: "tool-call", id: "tool", name: "read_file", args: { path: "fixture.ts" }, status: "calling" }], loading: true },
    { name: "tool result", parts: [{ type: "tool-call", id: "tool", name: "read_file", args: {}, status: "done", result: "conteúdo" }] },
    { name: "tool error", parts: [{ type: "tool-call", id: "tool", name: "read_file", args: {}, status: "done", result: "Error: arquivo inexistente" }] },
];

test.each(cases)("chat renders after sending: $name", async ({ parts, loading = false }) => {
    let send!: () => void;
    function Harness() {
        const [sent, setSent] = useState(false);
        send = () => setSent(true);
        return <SessionShell onSubmit={send} loading={sent && loading} interruptible totalTokens={sent ? 42 : 0}>
            {sent && <>
                <UserrMessage message="Mensagem 👋" mode="BUILD" />
                <BotMessage parts={parts} model="fixture" mode="BUILD" streaming={loading} />
                <ErrorMessage message="Falha simulada" />
            </>}
        </SessionShell>;
    }
    const router = createMemoryRouter([{ path: "/", element: <ThemeProvider><KeyboardLayerProvider><PromptConfigProvider><ToastProvider><DialogProvider><Harness /></DialogProvider></ToastProvider></PromptConfigProvider></KeyboardLayerProvider></ThemeProvider> }]);
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => {
            ui = await testRender(<RouterProvider router={router} />, { width: 90, height: 50 });
        });
        await act(async () => { await ui.mockInput.typeText("Mensagem"); });
        await act(async () => { ui.mockInput.pressEnter(); });
        await ui.waitForFrame(frame => frame.includes("Mensagem") && frame.includes("Falha simulada"));
        expect(ui.captureCharFrame()).toContain("fixture");
        if (parts.some(part => part.type === "context-warning")) expect(ui.captureCharFrame()).toContain("Perfil compacto: janela estimada de 16384 tokens");
    } finally { if (ui) await act(async () => { ui.renderer.destroy(); }); router.dispose(); }
});

if (!process.env.MYAGENT_BUNDLE_REGRESSION) test("chat also renders from the installed Bun bundle", async () => {
    const directory = await mkdtemp(resolve(import.meta.dirname, "../../.chat-bundle-"));
    try {
        const build = await Bun.build({
            entrypoints: [import.meta.path], outdir: directory, target: "bun",
            external: ["bun:test", "@opentui/core", "@opentui/react", "react"],
            tsconfig: resolve(import.meta.dirname, "../../tsconfig.json"),
        });
        expect(build.success).toBe(true);
        const child = Bun.spawn([process.execPath, "test", build.outputs[0]!.path], {
            env: { ...process.env, MYAGENT_BUNDLE_REGRESSION: "1" }, stdout: "pipe", stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (code !== 0) throw new Error(stdout + stderr);
    } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);
