import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { ScrollBoxRenderable } from "@opentui/core";
import type { ChatStreamEvent } from "@myagent/shared";
import { SESSION_APPROVAL_FORBIDDEN } from "@myagent/shared";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { approvalPreview } from "./approval-preview";

type Approval = Extract<ChatStreamEvent, { type: "approval-required" }>;
export function ApprovalPanel({ approval, decide, interrupt = () => {} }: {
    approval: Approval; decide: (id: string, approved: boolean, remember?: boolean, confirmation?: string) => Promise<void>; interrupt?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [confirmingMain, setConfirmingMain] = useState(false);
    const busyRef = useRef(false);
    const [error, setError] = useState("");
    const scroll = useRef<ScrollBoxRenderable>(null);
    const { isTopLayer, push, pop } = useKeyboardLayer();
    const interruptRef = useRef(interrupt); interruptRef.current = interrupt;
    useEffect(() => { push("approval", () => { interruptRef.current(); return true; }); return () => pop("approval"); }, [push, pop]);
    const sessionAllowed = approval.allowSession === true && !SESSION_APPROVAL_FORBIDDEN.includes(approval.toolName);
    const respond = async (approved: boolean, remember = false, confirmed = false) => {
        if (busyRef.current || remember && !sessionAllowed) return;
        if (approved && approval.confirmation && !confirmed) { setConfirmingMain(true); return; }
        busyRef.current = true; setBusy(true); setError("");
        try { await decide(approval.approvalId, approved, remember, approved && confirmed ? approval.confirmation : undefined); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { busyRef.current = false; setBusy(false); }
    };
    useKeyboard(key => {
        if (!isTopLayer("approval") || key.ctrl || key.meta) return;
        const name = key.name.toLowerCase();
        if (["y", "a", "n"].includes(name)) {
            key.preventDefault(); void respond(name !== "n", name === "a");
        } else if (name === "m" && confirmingMain) { key.preventDefault(); void respond(true, false, true); }
        else if (key.name === "escape") { key.preventDefault(); interruptRef.current(); }
        else if (["return", "enter", "tab"].includes(key.name)) key.preventDefault();
        else if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
            key.preventDefault(); scroll.current?.scrollBy(key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -10 : 10);
        }
    });
    return <box flexDirection="column" border padding={1} flexShrink={0}>
        <text>Aprovação necessária: {approval.toolName}</text>
        <scrollbox ref={scroll} height={12}>
            {approval.scope && <text>{approval.scope}</text>}
            <box flexDirection="column">{approvalPreview(approval).map((line, index) => <text key={index} fg={line.color}>{line.text || " "}</text>)}</box>
        </scrollbox>
        {error && <text fg="red">{error}</text>}
        {confirmingMain && <text fg="red">Confirmar envio direto para {approval.confirmation}: pressione M para autorizar explicitamente, ou N para negar.</text>}
        <box flexDirection="row" gap={2}>
            <text onMouseDown={() => { if (isTopLayer("approval")) void respond(true); }}>{busy ? "Enviando..." : "[Y] Permitir uma vez"}</text>
            {sessionAllowed && <text onMouseDown={() => { if (isTopLayer("approval")) void respond(true, true); }}>[A] Permitir nesta sessão</text>}
            <text onMouseDown={() => { if (isTopLayer("approval")) void respond(false); }}>[N] Negar</text>
        </box>
        <text>↑↓ / PgUp/PgDn: rolar · Esc / Ctrl+C: interromper · Enter não aprova</text>
    </box>;
}
