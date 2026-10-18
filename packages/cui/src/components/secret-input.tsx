import { useRef } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { useKeyboardLayer } from "../providers/keyboard-layer";

/** A chave existe apenas no estado; o buffer renderizado contém somente a máscara. */
export function SecretInput({ value, onChange, focused = true }: { value: string; onChange: (value: string) => void; focused?: boolean }) {
    const { isTopLayer } = useKeyboardLayer();
    const current = useRef(value); current.current = value;
    const active = () => focused && isTopLayer("dialog");
    const update = (text: string) => { current.current = text.slice(0, 32768); onChange(current.current); };
    useKeyboard(key => {
        if (!active() || key.defaultPrevented) return;
        if (key.ctrl && ["u", "w"].includes(key.name)) { key.preventDefault(); update(""); }
        else if (key.name === "backspace" || key.name === "delete") { key.preventDefault(); update(Array.from(current.current).slice(0, -1).join("")); }
        else if (!key.ctrl && !key.meta && !key.option && key.sequence && !/[\x00-\x1f\x7f-\x9f]/.test(key.sequence) && !["left", "right", "up", "down", "home", "end", "tab", "return", "enter"].includes(key.name)) {
            key.preventDefault(); update(current.current + key.sequence);
        }
    });
    usePaste(event => {
        if (!active()) return;
        event.preventDefault(); event.stopPropagation();
        update(current.current + new TextDecoder().decode(event.bytes).replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
    });
    return <box height={1} width="100%"><text>{value ? "•".repeat(Math.min(Array.from(value).length, 64)) : focused ? "Cole ou digite a chave (oculta)" : "Chave de API"}</text></box>;
}
