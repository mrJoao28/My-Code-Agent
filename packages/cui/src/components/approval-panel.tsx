import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ChatStreamEvent } from "@myagent/shared";
import { useKeyboardLayer } from "../providers/keyboard-layer";

type Approval = Extract<ChatStreamEvent, { type: "approval-required" }>;
export function ApprovalPanel({ approval, decide }: { approval: Approval; decide: (id: string, approved: boolean) => Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const { isTopLayer } = useKeyboardLayer();
    const respond = async (approved: boolean) => {
        if (busy) return;
        setBusy(true);
        try { await decide(approval.approvalId, approved); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    useKeyboard(key => {
        if (!isTopLayer("base")) return;
        if (key.name === "y" || key.name === "n") {
            key.preventDefault();
            void respond(key.name === "y");
        }
    });
    return <box flexDirection="column" border padding={1}>
        <text>Approval required: {approval.toolName}</text>
        <scrollbox maxHeight={14}><text>{JSON.stringify(approval.args, null, 2)}</text></scrollbox>
        {error && <text fg="red">{error}</text>}
        <box flexDirection="row" gap={3}>
            <text onMouseDown={() => { void respond(true); }}>{busy ? "Sending..." : "[Y] Allow this action"}</text>
            <text onMouseDown={() => { void respond(false); }}>[N] Deny</text>
        </box>
    </box>;
}
