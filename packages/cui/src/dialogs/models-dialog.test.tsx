import { expect, mock, test } from "bun:test";
import { act, useEffect } from "react";
import { testRender } from "@opentui/react/test-utils";
import { browserCommand } from "../lib/open-browser";
import { ThemeProvider } from "../providers/theme";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { DialogProvider, useDialog } from "../providers/dialog";

let cancelled = 0;
let created: unknown;
const selected: string[] = [];
mock.module("../lib/open-browser", () => ({ browserCommand, openBrowser: async () => {} }));
mock.module("../lib/api-client", () => ({ appClient: {
    models: {
        $get: async () => Response.json([]),
        $post: async ({ json }: { json: unknown }) => { created = json; return Response.json({ ok: true }, { status: 201 }); },
    },
    chatgpt: {
        $get: async () => Response.json({ connected: false, accounts: [] }),
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
