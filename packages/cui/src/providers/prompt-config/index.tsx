import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useKeyboard, useRenderer } from "@opentui/react";

type Responder = () => boolean;

type KeyboardLayerContextValue = {
  push: (id: string, responder?: Responder) => void;
  pop: (id: string) => void;
  isTopLayer: (id: string) => boolean;
  setResponder: (id: string, responder: Responder | null) => void;
};

const KeyboardLayerContext = createContext<KeyboardLayerContextValue | null>(null);

export function KeyboardLayerProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<string[]>(["base"]);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const responders = useRef<Map<string, Responder>>(new Map());
  const renderer = useRenderer();

  const push = useCallback((id: string, responder?: Responder) => {
    if (responder) {
      responders.current.set(id, responder);
    }

    setStack((prev) => {
      // Se a camada já for a do topo, não atualiza o estado
      if (prev[prev.length - 1] === id) return prev;
      const filtered = prev.filter((layer) => layer !== id);
      return [...filtered, id];
    });
  }, []);

  const pop = useCallback((id: string) => {
    responders.current.delete(id);
    setStack((prev) => {
      // 🛑 CORREÇÃO CRÍTICA: Se a camada não está na pilha, NÃO altera o estado
      if (!prev.includes(id)) return prev;
      return prev.filter((layer) => layer !== id);
    });
  }, []);

  const isTopLayer = useCallback(
    (id: string) => {
      if (stack.length === 0) return true;
      return stack[stack.length - 1] === id;
    },
    [stack]
  );

  const setResponder = useCallback((id: string, responder: Responder | null) => {
    if (responder) {
      responders.current.set(id, responder);
    } else {
      responders.current.delete(id);
    }
  }, []);

  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return;

    const currentStack = stackRef.current;
    for (let i = currentStack.length - 1; i >= 0; i--) {
      const layerId = currentStack[i]!;
      const responder = responders.current.get(layerId);
      if (responder && responder()) {
        return;
      }
    }
    renderer.destroy();
  });

  const value = useMemo(
    () => ({ push, pop, isTopLayer, setResponder }),
    [push, pop, isTopLayer, setResponder]
  );

  return (
    <KeyboardLayerContext.Provider value={value}>
      {children}
    </KeyboardLayerContext.Provider>
  );
}

export function useKeyboardLayer() {
  const context = useContext(KeyboardLayerContext);
  if (!context) {
    throw new Error("useKeyboardLayer must be used within a KeyboardLayerProvider");
  }
  return context;
}