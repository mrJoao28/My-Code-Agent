import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../providers/theme";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { DialogProvider, useDialog } from "../providers/dialog";
import { ToastProvider } from "../providers/toast";
import { PromptConfigProvider, usePromptConfig } from "../providers/prompt-config";
import { InputBar } from "../components/input-bar";
import { AgentsDialogContent } from "./agents-dialog";

function Modes() {
    const { mode, setMode } = usePromptConfig();
    const dialog = useDialog();
    useEffect(() => { dialog.open({ title: "Modes", children: <AgentsDialogContent currentMode={mode} onSelectMode={setMode} /> }); }, []);
    return <box><InputBar onSubmit={() => { throw new Error("Base must not submit with an open dialog"); }} /><text>Current: {mode}</text></box>;
}

test.each(["enter", "tab-escape", "down-enter"])("agents starts at PLAN and respects dialog keyboard layer: %s", async action => {
    const router = createMemoryRouter([{ path: "/", element: <ThemeProvider><KeyboardLayerProvider><DialogProvider><ToastProvider><PromptConfigProvider initialMode="PLAN"><Modes /></PromptConfigProvider></ToastProvider></DialogProvider></KeyboardLayerProvider></ThemeProvider> }]);
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<RouterProvider router={router} />, { width: 90, height: 30 }); });
        await ui.waitForFrame(frame => frame.includes("Search modes"));
        if (action === "tab-escape") {
            await act(async () => { ui.mockInput.pressTab(); });
            await act(async () => { ui.mockInput.pressEscape(); await Bun.sleep(100); });
        } else {
            // PLAN is the last item; an up arrow intentionally selects BUILD.
            if (action === "down-enter") await act(async () => { ui.mockInput.pressArrow("up"); });
            await act(async () => { ui.mockInput.pressEnter(); });
        }
        await ui.waitForFrame(frame => !frame.includes("Search modes"));
        expect(ui.captureCharFrame()).toContain(action === "down-enter" ? "Current: BUILD" : "Current: PLAN");
    } finally { await act(async () => { ui?.renderer.destroy(); }); router.dispose(); }
});
