import { useRef, useState, useMemo, useCallback, type RefObject } from "react";
import { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getFilteredCommands } from "./filter-commands";
import type { Command } from "./types";

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

  const commandQuery =
    showCommandMenu && textValue.startsWith("/") ? textValue.slice(1) : "";

  const filteredCommands = useMemo(
    () => getFilteredCommands(commandQuery),
    [commandQuery]
  );

  const handleContentChange = useCallback((text: string) => {
    setTextValue(text);
    setSelectedIndex(0);

    const prefix = text.startsWith("/") ? text.slice(1) : null;
    const shouldShow = prefix !== null && !prefix.includes(" ");

    setShowCommandMenu(shouldShow);
  }, []);

  const resolveCommand = useCallback(
    (index: number): Command | undefined => {
      const command = filteredCommands[index];
      if (command) {
        setShowCommandMenu(false);
      }
      return command;
    },
    [filteredCommands]
  );

  // Escuta apenas as teclas de controle do menu SEM travar a digitação no textarea
  useKeyboard((key) => {
    if (!showCommandMenu) return;

    if (key.name === "escape") {
      key.preventDefault();
      setShowCommandMenu(false);
    } else if (key.name === "up") {
      key.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.name === "down") {
      key.preventDefault();
      setSelectedIndex((i) =>
        filteredCommands.length === 0
          ? 0
          : Math.min(filteredCommands.length - 1, i + 1)
      );
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