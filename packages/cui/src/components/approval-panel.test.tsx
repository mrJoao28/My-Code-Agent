import { expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ChatStreamEvent } from "@myagent/shared";
import { KeyboardLayerProvider, useKeyboardLayer } from "../providers/keyboard-layer";
import { ApprovalPanel } from "./approval-panel";
import { approvalPreview } from "./approval-preview";
import { SESSION_APPROVAL_FORBIDDEN } from "@myagent/shared";

type Approval = Extract<ChatStreamEvent, { type: "approval-required" }>;
const approval = (toolName: string, args: Approval["args"]): Approval => ({ type: "approval-required", approvalId: "id", toolName, args, scope: "Caminhos: src/a.ts", allowSession: true });
const cases = [
    approval("bash", { command: "bun test --timeout 10000" }),
    approval("edit_file", { path: "src/a.ts", old_str: "before", new_str: "after" }),
    approval("apply_patch", { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before\n+after" }),
    approval("write_file", { path: "src/a.ts", content: "Olá" }),
    approval("web_fetch", { url: "https://example.com/docs/path?full=query#section" }),
    approval("move_file", { from: "src/a.ts", to: "src/b.ts" }),
    approval("delete_file", { path: "src/a.ts" }),
    approval("git_commit", { message: "fixture commit", files: ["src/a.ts"] }),
    approval("git_init", {}),
    approval("git_switch", { branch: "feature/x", create: true }),
    approval("git_remote_add", { remote: "origin", url: "https://github.com/o/r" }),
    approval("git_push", { remote: "origin", branch: "feature/x", url: "https://github.com/o/r" }),
    approval("git_sync", { remote: "origin", branch: "main", url: "https://github.com/o/r" }),
];

test.each(cases)("approval renders readable Portuguese preview for $toolName", async item => {
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<KeyboardLayerProvider><ApprovalPanel approval={item} decide={async () => {}} /></KeyboardLayerProvider>, { width: 110, height: 24 }); });
        await ui.waitForFrame(frame => frame.includes("Aprovação necessária"));
        const frame = ui.captureCharFrame();
        expect(frame).toContain("Permitir uma vez"); expect(frame).toContain("Negar");
        for (const line of approvalPreview(item)) expect(frame).toContain(line.text);
        if (SESSION_APPROVAL_FORBIDDEN.includes(item.toolName)) expect(frame).not.toContain("Permitir nesta sessão");
        if (item.toolName === "write_file") expect(frame).toContain("4 bytes");
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});

test("main push requires Y then explicit M; Enter and session approval cannot authorize it", async () => {
    const item = { ...approval("git_push", { remote: "origin", branch: "main", url: "https://github.com/o/r" }), confirmation: "main" };
    const decisions: unknown[] = [];
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<KeyboardLayerProvider><ApprovalPanel approval={item} decide={async (...args) => { decisions.push(args); }} /></KeyboardLayerProvider>, { width: 130, height: 26 }); });
        await act(async () => { ui.mockInput.pressEnter(); await ui.mockInput.typeText("a"); await ui.mockInput.typeText("m"); });
        expect(decisions).toEqual([]);
        await act(async () => { await ui.mockInput.typeText("y"); });
        await ui.waitForFrame(frame => frame.includes("Confirmar envio direto para main"));
        expect(decisions).toEqual([]);
        await act(async () => { ui.mockInput.pressEnter(); });
        expect(decisions).toEqual([]);
        await act(async () => { await ui.mockInput.typeText("m"); });
        expect(decisions).toEqual([["id", true, false, "main"]]);
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});

test("diff lines retain add/remove colors and long content is available by scrolling", async () => {
    const item = approval("edit_file", { path: "a", old_str: "before", new_str: Array.from({ length: 80 }, (_, i) => "after-" + i).join("\n") });
    expect(approvalPreview(item).find(line => line.text === "-before")?.color).toBe("red");
    expect(approvalPreview(item).find(line => line.text === "+after-79")?.color).toBe("green");
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<KeyboardLayerProvider><ApprovalPanel approval={item} decide={async () => {}} /></KeyboardLayerProvider>, { width: 100, height: 24 }); });
        expect(ui.captureCharFrame()).not.toContain("after-79");
        for (let i = 0; i < 90; i++) await act(async () => { ui.mockInput.pressArrow("down"); });
        await ui.waitForFrame(frame => frame.includes("after-79"));
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});

test.each(["y", "a", "n", "enter", "escape", "ctrl-c", "overlay", "tab"])("approval keyboard preserves focus, layers and explicit choices: %s", async action => {
    const choices: [boolean, boolean | undefined][] = []; let interrupted = 0;
    let overlay!: () => void;
    function Harness() {
        const { push } = useKeyboardLayer();
        const [open, setOpen] = useState(true);
        overlay = () => { push("test-dialog"); };
        return open ? <ApprovalPanel approval={approval("write_file", { path: "a", content: "preview" })} decide={async (_id, approved, remember) => { choices.push([approved, remember]); setOpen(false); }} interrupt={() => { interrupted++; setOpen(false); }} /> : <text>Pedido encerrado</text>;
    }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    try {
        await act(async () => { ui = await testRender(<KeyboardLayerProvider><Harness /></KeyboardLayerProvider>, { width: 110, height: 24 }); });
        if (action === "overlay") await act(async () => { overlay(); });
        await act(async () => {
            if (action === "enter") ui.mockInput.pressEnter();
            else if (action === "escape") { ui.mockInput.pressEscape(); await Bun.sleep(100); }
            else if (action === "ctrl-c") ui.mockInput.pressCtrlC();
            else if (action === "tab") ui.mockInput.pressTab();
            else await ui.mockInput.typeText(action === "overlay" ? "y" : action);
        });
        if (["escape", "ctrl-c"].includes(action)) await ui.waitFor(() => interrupted === 1);
        if (["y", "a", "n"].includes(action)) expect(choices).toEqual([[action !== "n", action === "a"]]);
        else expect(choices).toEqual([]);
        expect(interrupted).toBe(["escape", "ctrl-c"].includes(action) ? 1 : 0);
    } finally { await act(async () => { ui?.renderer.destroy(); }); }
});
