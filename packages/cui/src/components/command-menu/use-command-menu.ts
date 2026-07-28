import { useRef, useState, useMemo, type RefObject } from "react";
import { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getFilteredCommands } from "./filter-commands";
import type { Command } from "./types";
import { useKeyboardLayer } from "../../providers/toast/keyboard-layer";

type UseCommandMenuReturn = {
    showCommandMenu: boolean;
    commandQuery: string;
    selectedIndex: number;
    scrollRef: RefObject<ScrollBoxRenderable | null>;
    handleContentChange: (text: string) => void;
    resolveCommand: (index: number) => Command | undefined;
    setSelectedIndex: (index: number) => void;
};
 
export function useCommandMenu(): UseCommandMenuReturn {
    const [textValue, setTextValue] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [showCommandMenu, setShowCommandMenu] = useState(false);
    const scrollRef = useRef<ScrollBoxRenderable>(null);
    const {push , pop , isTopLayer} = useKeyboardLayer()
 
    const commandQuery =
        showCommandMenu && textValue.startsWith("/") ? textValue.slice(1) : "";
 
    const filteredCommands = useMemo(
        () => getFilteredCommands(commandQuery),
        [commandQuery]
    );
 
    const handleContentChange = (text: string) => {
        setTextValue(text);
        setSelectedIndex(0);
 
        const scrollbox = scrollRef.current;
        if (scrollbox) {
            scrollbox.scrollTo({ x: 0, y: 0 });
        }
 
        const prefix = text.startsWith("/") ? text.slice(1) : null;
        if (prefix !== null && !prefix.includes(" ")) {
            setShowCommandMenu(true);
            push("command",()=>{
                setShowCommandMenu(false);
                pop("command")
                return true
            })
        } else {
            setShowCommandMenu(false);
            pop("command")
        }
    };
 
    const resolveCommand = (index: number): Command | undefined => {
        const command = filteredCommands[index];
        if (command) {
            setShowCommandMenu(false);
            pop("command")
        }
        return command;
    };
 
    useKeyboard((key) => {
        if (!showCommandMenu || !isTopLayer("command")) return;
 
        if (key.name === "escape") {
            key.preventDefault();
            setShowCommandMenu(false);
            pop("command")
        } else if (key.name === "up") {
            key.preventDefault();
            setSelectedIndex((i: number) => {
                const newIndex = Math.max(0, i - 1);
                const sb = scrollRef.current;
                const scrollTop = sb?.verticalScrollBar?.scrollPosition ?? 0;
                if (sb && newIndex < scrollTop) {
                    sb.scrollTo({ x: 0, y: newIndex });
                }
                return newIndex;
            });
        } else if (key.name === "down") {
            key.preventDefault();
            setSelectedIndex((i: number) => {
                if (filteredCommands.length === 0) {
                    return 0;
                }
 
                const newIndex = Math.min(filteredCommands.length - 1, i + 1);
                const sb = scrollRef.current;
 
                if (sb?.verticalScrollBar) {
                    const scrollTop = sb.verticalScrollBar.scrollPosition;
                    const viewportHeight = sb.verticalScrollBar.viewportSize;
                    const visibleEnd = scrollTop + viewportHeight - 1;
 
                    if (newIndex > visibleEnd) {
                        sb.scrollTo({ x: 0, y: newIndex - viewportHeight + 1 });
                    }
                }
                return newIndex;
            });
        }
    });
 
    return {
        showCommandMenu,
        commandQuery,
        selectedIndex,
        scrollRef,
        handleContentChange,
        resolveCommand,
        setSelectedIndex,
    };
}
 