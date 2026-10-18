import { useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { useKeyboardLayer } from "../providers/keyboard-layer";

export function ResumePanel({ confirm, dismiss }: { confirm: () => Promise<void>; dismiss: () => void }) {
    const { push, pop, isTopLayer } = useKeyboardLayer();
    const dismissRef = useRef(dismiss); dismissRef.current = dismiss;
    const busy = useRef(false);
    useEffect(() => { push("resume", () => { dismissRef.current(); return true; }); return () => pop("resume"); }, [push, pop]);
    const accept = () => { if (!busy.current) { busy.current = true; void confirm().finally(() => { busy.current = false; }); } };
    useKeyboard(key => {
        if (!isTopLayer("resume") || key.ctrl || key.meta) return;
        const name = key.name.toLowerCase();
        if (name === "y") { key.preventDefault(); accept(); }
        else if (name === "n" || name === "escape") { key.preventDefault(); dismiss(); }
        else if (["return", "enter", "tab"].includes(name)) key.preventDefault();
    });
    return <box border padding={1} flexDirection="column" flexShrink={0}>
        <text>Retomar a geração pendente?</text>
        <text>O que já foi registrado está no histórico. Continuar usa tokens.</text>
        <text onMouseDown={() => { if (isTopLayer("resume")) accept(); }}>[Y] Retomar</text>
        <text onMouseDown={() => { if (isTopLayer("resume")) dismiss(); }}>[N] Agora não · Esc / Ctrl+C: fechar · Enter não retoma</text>
    </box>;
}
