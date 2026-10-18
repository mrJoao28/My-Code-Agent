import { expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { KeyboardLayerProvider, useKeyboardLayer } from "../providers/keyboard-layer";
import { ResumePanel } from "./resume-panel";

test.each(["y", "n", "enter", "escape", "ctrl-c", "overlay", "tab"])("resume requires explicit consent and preserves keyboard layers: %s", async action => {
    let accepted = 0, dismissed = 0;
    let overlay!: () => void;
    function Harness() {
        const [open, setOpen] = useState(true);
        const { push } = useKeyboardLayer();
        overlay = () => push("other-dialog");
        return open ? <ResumePanel confirm={async () => { accepted++; setOpen(false); }} dismiss={() => { dismissed++; setOpen(false); }} /> : <text>Fechado</text>;
    }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<KeyboardLayerProvider><Harness /></KeyboardLayerProvider>, { width: 110, height: 12 }); });
        expect(ui.captureCharFrame()).toContain("Retomar a geração pendente?");
        if (action === "overlay") await act(async () => { overlay(); });
        await act(async () => {
            if (action === "enter") ui.mockInput.pressEnter();
            else if (action === "tab") ui.mockInput.pressTab();
            else if (action === "escape") { ui.mockInput.pressEscape(); await Bun.sleep(100); }
            else if (action === "ctrl-c") ui.mockInput.pressCtrlC();
            else await ui.mockInput.typeText(action === "overlay" ? "y" : action);
        });
        expect(accepted).toBe(action === "y" ? 1 : 0);
        expect(dismissed).toBe(["n", "escape", "ctrl-c"].includes(action) ? 1 : 0);
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});
