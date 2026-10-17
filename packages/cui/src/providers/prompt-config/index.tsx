import { createContext, useContext, useState, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { DEFAULT_CHAT_MODEL_ID, type SupportedChatModelId } from "@myagent/shared";
import { Mode } from "@myagent/database/enums";

type PromptConfigContextValue = {
  mode: Mode;
  toggleMode: () => void;
  setMode: (mode: Mode) => void;
  model: SupportedChatModelId;
  setModel: (model: SupportedChatModelId) => void;
};

const PromptConfigContext = createContext<PromptConfigContextValue | null>(null);

export function usePromptConfig(): PromptConfigContextValue {
  const value = useContext(PromptConfigContext);

  if (!value) {
    throw new Error("usePromptConfig must be used within a PromptConfigProvider");
  }

  return value;
}

type PromptConfigProviderProps = {
  children: ReactNode;
  initialMode?: Mode;
};

export function PromptConfigProvider({ children, initialMode = Mode.BUILD }: PromptConfigProviderProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const parent = useContext(PromptConfigContext);
  const [localModel, setLocalModel] = useState<SupportedChatModelId>(DEFAULT_CHAT_MODEL_ID);
  // Sessões isolam o modo, mantendo a seleção de modelo compartilhada.
  const model = parent?.model ?? localModel;
  const setModel = parent?.setModel ?? setLocalModel;

  const toggleMode = useCallback(() => {
    setMode((m) => (m === Mode.BUILD ? Mode.PLAN : Mode.BUILD));
  }, []);

  const value = useMemo(
    () => ({
      mode,
      toggleMode,
      setMode,
      model,
      setModel,
    }),
    [mode, toggleMode, setMode, model, setModel]
  );

  return (
    <PromptConfigContext.Provider value={value}>
      {children}
    </PromptConfigContext.Provider>
  );
}
