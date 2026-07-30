import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { useRef, useState, useCallback, useEffect, type RefObject } from "react";
import { useNavigate } from "react-router";
import {
  TextAttributes,
  TextareaRenderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer, useKeyboard } from "@opentui/react";

import { CommandMenu } from "./command-menu";
import type { Command } from "./command-menu/types";
import { useCommandMenu } from "./command-menu/use-command-menu";
import { useToast } from "../providers/toast";
import { useDialog } from "../providers/dialog";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "../../../database/generated/prisma/enums";

const MAX_VISIBLE_MENTIONS = 8;
const CURRENT_DIRECTORY = process.cwd();
const MAX_FALLBACK_MENTION_CANDIDATES = 32;
const MENTION_QUERY_CHARACTER = /[A-Za-z0-9._/-]/;
const RECURSIVE_MENTION_IGNORED_DIRECTORIES = new Set(["node_modules"]);

type MentionMatch = {
  start: number;
  end: number;
  query: string;
};

type MentionCandidate = {
  path: string;
  kind: "file" | "directory";
};

function isWithinCurrentDirectory(targetPath: string) {
  const relativePath = relative(CURRENT_DIRECTORY, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function isMentionQueryCharacter(character: string) {
  return MENTION_QUERY_CHARACTER.test(character);
}

function findActiveMention(text: string, cursorOffset: number): MentionMatch | null {
  const safeOffset = Math.max(0, Math.min(cursorOffset, text.length));

  let start = safeOffset;
  while (start > 0 && !/\s/.test(text[start - 1]!)) {
    start -= 1;
  }
  let end = safeOffset;
  while (end > 0 && !/\s/.test(text[end - 1]!)) {
    end += 1;
  }

  const token = text.slice(start, end);
  const relativeCursor = safeOffset - start;
  const mentionStart = token.lastIndexOf("@", relativeCursor);
  if (mentionStart === -1) {
    return null;
  }

  const previousCharacter = token[mentionStart - 1];
  if (previousCharacter && isMentionQueryCharacter(previousCharacter)) {
    return null;
  }
  let mentionEnd = mentionStart + 1;
  while (
    mentionEnd < token.length &&
    isMentionQueryCharacter(token[mentionEnd]!)
  ) {
    mentionEnd += 1;
  }

  if (relativeCursor < mentionStart || relativeCursor > mentionEnd) {
    return null;
  }

  return {
    start: start + mentionStart,
    end: start + mentionEnd,
    query: token.slice(mentionStart + 1, mentionEnd),
  };
}

async function getMentionCandidates(query: string): Promise<MentionCandidate[]> {
  const normalizedQuery = query.startsWith("./") ? query.slice(2) : query;
  if (normalizedQuery.startsWith("/")) return [];

  const hasTrailingSlash = normalizedQuery.endsWith("/");
  const lastSlashIndex = hasTrailingSlash
    ? normalizedQuery.length - 1
    : normalizedQuery.lastIndexOf("/");

  const directoryPart = hasTrailingSlash
    ? normalizedQuery.slice(0, -1)
    : lastSlashIndex === -1
    ? ""
    : normalizedQuery.slice(0, lastSlashIndex);

  const namePrefix = hasTrailingSlash
    ? ""
    : lastSlashIndex === -1
    ? normalizedQuery
    : normalizedQuery.slice(lastSlashIndex + 1);

  const absoluteDirectory = resolve(CURRENT_DIRECTORY, directoryPart || ".");
  if (!isWithinCurrentDirectory(absoluteDirectory)) return [];

  try {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const lowercasePrefix = namePrefix.toLowerCase();
    const showHiddenEntries = namePrefix.startsWith(".");

    const directMatches = entries
      .filter((entry) => showHiddenEntries || !entry.name.startsWith("."))
      .filter((entry) =>
        lowercasePrefix === "" ||
        entry.name.toLowerCase().startsWith(lowercasePrefix)
      )
      .map((entry) => {
        const path = directoryPart ? `${directoryPart}/${entry.name}` : entry.name;
        const kind: MentionCandidate["kind"] = entry.isDirectory()
          ? "directory"
          : "file";
        return {
          path: kind === "directory" ? `${path}/` : path,
          kind,
        };
      });

    if (directMatches.length > 0 || directoryPart !== "" || namePrefix === "") {
      return directMatches;
    }

    const fallbackMatches: MentionCandidate[] = [];
    const visit = async (absDir: string, dirPart: string): Promise<void> => {
      const dirEntries = await readdir(absDir, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (!showHiddenEntries && entry.name.startsWith(".")) continue;
        if (
          entry.isDirectory() &&
          RECURSIVE_MENTION_IGNORED_DIRECTORIES.has(entry.name)
        )
          continue;

        const path = dirPart ? `${dirPart}/${entry.name}` : entry.name;
        const kind: MentionCandidate["kind"] = entry.isDirectory()
          ? "directory"
          : "file";

        if (entry.name.toLowerCase().startsWith(lowercasePrefix)) {
          fallbackMatches.push({
            path: kind === "directory" ? `${path}/` : path,
            kind,
          });
          if (fallbackMatches.length >= MAX_FALLBACK_MENTION_CANDIDATES) return;
        }
        if (entry.isDirectory()) {
          await visit(resolve(absDir, entry.name), path);
          if (fallbackMatches.length >= MAX_FALLBACK_MENTION_CANDIDATES) return;
        }
      }
    };

    await visit(CURRENT_DIRECTORY, "");
    return fallbackMatches.sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

type FileMentionMenuProps = {
  candidates: MentionCandidate[];
  selectedIndex: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onSelect: (index: number) => void;
  onExecute: (index: number) => void;
};

function FileMentionMenu({
  candidates,
  selectedIndex,
  scrollRef,
  onSelect,
  onExecute,
}: FileMentionMenuProps) {
  const { colors } = useTheme();
  const visibleHeight = Math.min(candidates.length, MAX_VISIBLE_MENTIONS);

  if (candidates.length === 0) {
    return (
      <box paddingX={1}>
        <text attributes={TextAttributes.DIM}>No matching files or folders</text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} height={visibleHeight}>
      {candidates.map((candidate, index) => {
        const isSelected = index === selectedIndex;
        return (
          <box
            key={candidate.path}
            flexDirection="row"
            paddingX={1}
            height={1}
            overflow="hidden"
            backgroundColor={isSelected ? colors.selection : undefined}
            onMouseMove={() => onSelect(index)}
            onMouseDown={() => onExecute(index)}
          >
            <box flexGrow={1} flexShrink={1} overflow="hidden">
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {candidate.path}
              </text>
            </box>
            <box width={8} alignItems="flex-end" flexShrink={0}>
              <text selectable={false} fg={isSelected ? "black" : "gray"}>
                {candidate.kind === "directory" ? "Folder" : "File"}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
}

type Props = {
  onSubmit: (text: string) => void;
  disabled?: boolean;
};

export function InputBar({ onSubmit, disabled = false }: Props) {
  // 🔑 1. Estado controlado para o texto do textarea
  const [inputValue, setInputValue] = useState("");

  const { mode, toggleMode, setMode, setModel } = usePromptConfig();
  const textareaRef = useRef<TextareaRenderable>(null);
  const renderer = useRenderer();
  const activeMentionRef = useRef<MentionMatch | null>(null);
  const mentionScrollerRef = useRef<ScrollBoxRenderable>(null);

  const toast = useToast();
  const dialog = useDialog();
  const { colors } = useTheme();
  const navigate = useNavigate();

  const [activeMention, setActiveMention] = useState<MentionMatch | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  const {
    showCommandMenu,
    commandQuery,
    selectedIndex,
    scrollRef,
    handleContentChange,
    resolveCommand,
    setSelectedIndex,
  } = useCommandMenu();

  const showMentionMenu = activeMention !== null;

  const closeMentionMenu = useCallback(() => {
    activeMentionRef.current = null;
    setActiveMention(null);
    setMentionCandidates([]);
  }, []);

  const syncMentionMenu = useCallback(
    (text: string, cursorOffset: number) => {
      const nextMention = findActiveMention(text, cursorOffset);
      const previousMention = activeMentionRef.current;

      if (!nextMention) {
        if (previousMention) closeMentionMenu();
        return;
      }

      const mentionChanged =
        previousMention?.start !== nextMention?.start ||
        previousMention?.end !== nextMention?.end ||
        previousMention?.query !== nextMention?.query;

      if (mentionChanged) {
        activeMentionRef.current = nextMention;
        setActiveMention(nextMention);
        setMentionSelectedIndex(0);
        mentionScrollerRef.current?.scrollTo(0);
      }
    },
    [closeMentionMenu]
  );

  const handleMentionExecute = useCallback(
    (index: number) => {
      const textarea = textareaRef.current;
      const mention = activeMentionRef.current;
      const candidate = mentionCandidates[index];

      if (!textarea || !mention || !candidate) return;

      const insertion =
        candidate.kind === "directory" ? candidate.path : `${candidate.path}`;
      const nextText = `${inputValue.slice(0, mention.start)}@${insertion}${inputValue.slice(
        mention.end
      )}`;

      setInputValue(nextText);
      textarea.setText(nextText);
      textarea.cursorOffset = mention.start + insertion.length + 1;
      closeMentionMenu();
    },
    [inputValue, mentionCandidates, closeMentionMenu]
  );

  const handleCommand = useCallback(
    (command: Command | undefined) => {
      if (!command) return;

      setInputValue("");
      if (textareaRef.current) {
        textareaRef.current.setText("");
      }

      if (command.action) {
        command.action({
          exit: () => renderer.destroy(),
          toast,
          dialog,
          navigate,
          mode,
          setMode,
          setModel,
        });
      } else {
        const nextText = command.value + " ";
        setInputValue(nextText);
        if (textareaRef.current) {
          textareaRef.current.setText(nextText);
        }
      }
    },
    [renderer, toast, dialog, navigate, mode, setMode, setModel]
  );

  const handleCommandExecute = useCallback(
    (index: number) => {
      const command = resolveCommand(index);
      handleCommand(command);
    },
    [resolveCommand, handleCommand]
  );

  useEffect(() => {
    if (!activeMention) {
      setMentionCandidates([]);
      return;
    }
    let ignore = false;
    const loadCandidates = async () => {
      const nextCandidates = await getMentionCandidates(activeMention.query);
      if (ignore) return;

      setMentionCandidates(nextCandidates);
      setMentionSelectedIndex((currentIndex) => {
        if (nextCandidates.length === 0) return 0;
        return Math.min(currentIndex, nextCandidates.length - 1);
      });
    };
    void loadCandidates();
    return () => {
      ignore = true;
    };
  }, [activeMention]);

  useKeyboard((key) => {
    if (disabled) return;

    if (key.name === "tab") {
      key.preventDefault();
      toggleMode();
      return;
    }

    if (showMentionMenu) {
      if (key.name === "escape") {
        key.preventDefault();
        closeMentionMenu();
      } else if (key.name === "up") {
        key.preventDefault();
        setMentionSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down") {
        key.preventDefault();
        setMentionSelectedIndex((i) =>
          mentionCandidates.length === 0
            ? 0
            : Math.min(mentionCandidates.length - 1, i + 1)
        );
      }
    }
  });

  return (
    <box width={"100%"} alignItems="center">
      <box
        width="100%"
        border={["left"]}
        borderColor={mode === Mode.BUILD ? colors.primary : colors.planMode}
      >
        <box
          position="relative"
          justifyContent="center"
          paddingX={2}
          paddingY={1}
          backgroundColor={colors.surface}
          width={"100%"}
          gap={1}
        >
          {/* 🔑 2. Textarea 100% controlado e com key estática */}
          <textarea
            key="stable-input-bar-textarea"
            ref={textareaRef}
            focused={!disabled}
            width={"100%"}
            value={inputValue}
            placeholder={"Ask anything ... 'Make a million dollar SAS'"}
            onContentChange={() => {
              const textarea = textareaRef.current;
              const text = textarea ? textarea.plainText : "";
              
              setInputValue(text);
              handleContentChange(text);
              if (textarea) {
                syncMentionMenu(text, textarea.cursorOffset);
              }
            }}
            onSubmit={() => {
              if (disabled) return;

              if (showCommandMenu) {
                handleCommandExecute(selectedIndex);
                return;
              }

              if (showMentionMenu && mentionCandidates[mentionSelectedIndex]) {
                handleMentionExecute(mentionSelectedIndex);
                return;
              }

              const text = inputValue.trim();
              if (text.length === 0) return;

              onSubmit(text);
              setInputValue("");
              if (textareaRef.current) {
                textareaRef.current.setText("");
              }
            }}
          />

          {showCommandMenu && (
            <box
              position="absolute"
              bottom={"100%"}
              left={0}
              width={"100%"}
              backgroundColor={colors.surface}
              zIndex={10}
            >
              <CommandMenu
                query={commandQuery}
                selectedIndex={selectedIndex}
                scrollRef={scrollRef}
                onSelect={setSelectedIndex}
                onExecute={handleCommandExecute}
              />
            </box>
          )}

          {!showCommandMenu && showMentionMenu && (
            <box
              position="absolute"
              bottom="100%"
              left={0}
              width={"100%"}
              backgroundColor={colors.surface}
              zIndex={10}
            >
              <FileMentionMenu
                candidates={mentionCandidates}
                selectedIndex={mentionSelectedIndex}
                scrollRef={mentionScrollerRef}
                onSelect={setMentionSelectedIndex}
                onExecute={handleMentionExecute}
              />
            </box>
          )}

          <StatusBar />
        </box>
      </box>
    </box>
  );
}

export function StatusBar() {
  const { mode, model } = usePromptConfig();
  const { colors } = useTheme();

  return (
    <box flexDirection="row" gap={1}>
      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {mode === Mode.PLAN ? "Plan" : "Build"}
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        {">"}
      </text>
      <text>{model}</text>
    </box>
  );
}