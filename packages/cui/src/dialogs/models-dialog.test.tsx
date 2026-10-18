import { expect, mock, test } from "bun:test";
import { act, useEffect } from "react";
import { testRender } from "@opentui/react/test-utils";
import { browserCommand } from "../lib/open-browser";
import { ThemeProvider } from "../providers/theme";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { DialogProvider, useDialog } from "../providers/dialog";

let cancelled = 0;
let created: unknown;
let cloudModels = false;
let enabled = true;
let broken = false;
let configuredKey: unknown;
const selected: string[] = [];
mock.module("../lib/open-browser", () => ({ browserCommand, openBrowser: async () => {} }));
mock.module("../lib/api-client", () => ({ appClient: {
    models: {
        $get: async () => broken ? Response.json({ error: "models.json corrompido: corrija o arquivo" }, { status: 503 }) : Response.json(cloudModels ? [{ id: "fixture-cloud", provider: "openai", configured: false }] : []),
        ":id": { key: { $post: async ({ json }: { json: unknown }) => { configuredKey = json; return Response.json({ configured: true }); } } },
        $post: async ({ json }: { json: unknown }) => { created = json; return Response.json({ ok: true }, { status: 201 }); },
    },
    chatgpt: {
        $get: async () => Response.json({ enabled, connected: false, accounts: [] }),
        login: {
            $post: async () => Response.json({ id: "fixture-attempt", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=fixture" }),
            ":id": {
                $get: async () => Response.json({ status: "waiting" }),
                $delete: async () => { cancelled++; return Response.json({ ok: true }); },
            },
        },
    },
} }));
const { ModelDialogContent } = await import("./models-dialog");

function OpenModels() {
    const { open } = useDialog();
    useEffect(() => { open({ title: "Models", children: <ModelDialogContent onSelectModel={id => selected.push(id)} /> }); }, [open]);
    return <text>Base</text>;
}
function Harness() {
    return <ThemeProvider><KeyboardLayerProvider><DialogProvider><OpenModels /></DialogProvider></KeyboardLayerProvider></ThemeProvider>;
}
async function renderHarness(options: Parameters<typeof testRender>[1] = {}) {
    let ui!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => { ui = await testRender(<Harness />, { width: 90, height: 40, ...options }); });
    return ui;
}

test("model dialog Enter/arrow navigation adds a local model without an API key", async () => {
    created = undefined; selected.length = 0;
    const ui = await renderHarness();
    try {
        await ui.waitForFrame(frame => frame.includes("Continuar com ChatGPT"));
        await act(async () => { ui.mockInput.pressArrow("down"); });
        await act(async () => { ui.mockInput.pressEnter(); });
        await ui.waitForFrame(frame => frame.includes("Ollama"));
        await act(async () => { await ui.mockInput.typeText("fixture-local:7b"); });
        await act(async () => { ui.mockInput.pressEnter(); });
        await ui.waitFor(() => selected.length === 1);
        expect(created).toEqual({ id: "fixture-local:7b", provider: "ollama" });
        expect(selected).toEqual(["fixture-local:7b"]);
    } finally { await act(async () => { ui.renderer.destroy(); }); }
});

test.each(["escape", "ctrl-c"])("closing ChatGPT login with %s cancels the backend attempt", async key => {
    cancelled = 0;
    let destroyed = false;
    const ui = await renderHarness({ onDestroy: () => { destroyed = true; } });
    try {
        await ui.waitForFrame(frame => frame.includes("Continuar com ChatGPT"));
        await act(async () => { ui.mockInput.pressEnter(); });
        await ui.waitForFrame(frame => frame.includes("Conectar ChatGPT"));
        await act(async () => { ui.mockInput.pressArrow("down"); });
        await act(async () => { ui.mockInput.pressEnter(); });
        await ui.waitForFrame(frame => frame.includes("Aguardando"));
        await act(async () => {
            if (key === "escape") { ui.mockInput.pressEscape(); await Bun.sleep(150); }
            else ui.mockInput.pressCtrlC();
        });
        if (!destroyed) await ui.waitFor(() => cancelled > 0);
        expect(cancelled).toBeGreaterThan(0);
        if (key === "ctrl-c") expect(destroyed).toBe(true);
    } finally { if (!destroyed) await act(async () => { ui.renderer.destroy(); }); }
});


test.each(["add", "configure"])("API key is masked during typing/paste and submitted intact: %s", async kind => {
    cloudModels = kind === "configure"; created = undefined; configuredKey = undefined;
    const ui = await renderHarness();
    const key = "private-secret-ALPHA";
    try {
        await ui.waitForFrame(frame => frame.includes("Continuar com ChatGPT"));
        await act(async () => { ui.mockInput.pressArrow("down"); });
        if (kind === "configure") await act(async () => { ui.mockInput.pressArrow("down"); });
        await act(async () => { ui.mockInput.pressEnter(); });
        if (kind === "add") {
            await ui.waitForFrame(frame => frame.includes("Ollama"));
            await act(async () => { ui.mockInput.pressArrow("right"); });
            await act(async () => { await ui.mockInput.typeText("fixture-model"); });
            await act(async () => { ui.mockInput.pressTab(); });
        } else await ui.waitForFrame(frame => frame.includes("API key required"));
        await act(async () => { await ui.mockInput.typeText("private-"); });
        await ui.waitForFrame(frame => frame.includes("••••"));
        expect(ui.captureCharFrame()).not.toContain("private-");
        await act(async () => { await ui.mockInput.pasteBracketedText("secret-ALPHA"); });
        await ui.waitForFrame(frame => frame.includes("•".repeat(key.length)));
        expect(ui.captureCharFrame()).not.toContain(key);
        expect(ui.captureCharFrame()).not.toContain("ALPHA");
        expect(ui.captureCharFrame()).toContain("••••");
        await act(async () => { ui.mockInput.pressEnter(); });
        await ui.waitFor(() => kind === "add" ? created !== undefined : configuredKey !== undefined);
        if (kind === "add") expect(created).toEqual({ id: "fixture-model", provider: "anthropic", token: key });
        else expect(configuredKey).toEqual({ token: key });
    } finally { cloudModels = false; await act(async () => { ui.renderer.destroy(); }); }
});

test("disabled ChatGPT explains opt-in and corrupted model configuration is visible", async () => {
    enabled = false; broken = true;
    const ui = await renderHarness();
    try {
        await ui.waitForFrame(frame => frame.includes("models.json corrompido"));
        await act(async () => { ui.mockInput.pressEnter(); });
        await ui.waitForFrame(frame => frame.includes("Login ChatGPT desativado"));
        expect(ui.captureCharFrame()).toContain("MYAGENT_ENABLE_CHATGPT=1");
    } finally { enabled = true; broken = false; await act(async () => { ui.renderer.destroy(); }); }
});
