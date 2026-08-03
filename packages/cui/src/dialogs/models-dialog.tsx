import { useCallback, useEffect, useState } from "react";
import { useDialog } from "../providers/dialog";
import { DialogSearchList } from "../components/dialog-search-list";
import { useTheme } from "../providers/theme";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, TextareaRenderable } from "@opentui/core";
import { useRef } from "react";
import { appClient } from "../lib/api-client";
import { SUPPORTED_CHAT_MODELS, type SupportedProvider } from "@myagent/shared";

type ModelsDialogContentProps = {
  onSelectModel: (modelId: string) => void;
};

type ModelProvider = SupportedProvider;

const PROVIDERS: { id: ModelProvider; label: string; kind: "Cloud" | "Local" }[] = [
  { id: "anthropic", label: "Anthropic", kind: "Cloud" },
  { id: "openai", label: "OpenAI", kind: "Cloud" },
  { id: "google", label: "Google", kind: "Cloud" },
  { id: "ollama", label: "Ollama", kind: "Local" },
];

export const ModelDialogContent = ({ onSelectModel }: ModelsDialogContentProps) => {
  const dialog = useDialog();
  const [models, setModels] = useState<string[]>(SUPPORTED_CHAT_MODELS.map((model) => model.id));
  const [adding, setAdding] = useState(false);

  const loadModels = useCallback(async () => {
    try {
      const response = await appClient.models.$get();
      if (!response.ok) return;
      const data = await response.json();
      setModels(data.map((model) => model.id));
    } catch {
      // Keep the built-in models available when the server is offline.
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const handleSelect = useCallback(
    (modelId: string) => {
      if (modelId === "__add_model__") {
        setAdding(true);
        return;
      }

      onSelectModel(modelId);
      dialog.close();
    },
    [dialog, onSelectModel],
  );

  if (adding) {
    return (
      <AddModelForm
        onCreated={(modelId) => {
          onSelectModel(modelId);
          dialog.close();
        }}
        onCancel={() => setAdding(false)}
      />
    );
  }

  const items = ["__add_model__", ...models];

  return (
    <DialogSearchList
      items={items}
      onSelect={handleSelect}
      filterFn={(item, query) =>
        item === "__add_model__" || item.toLowerCase().includes(query.toLowerCase())
      }
      renderItem={(item, isSelected) => (
        <text selectable={false} fg={isSelected ? "black" : "white"}>
          {item === "__add_model__" ? "+ Add model" : item}
        </text>
      )}
      getKey={(item) => item}
      placeholder="Search models"
      emptyText="No matching models"
    />
  );
};

type AddModelFormProps = {
  onCreated: (modelId: string) => void;
  onCancel: () => void;
};

function AddModelForm({ onCreated, onCancel }: AddModelFormProps) {
  const { colors } = useTheme();
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelName, setModelName] = useState("");
  const [token, setToken] = useState("");
  const [activeField, setActiveField] = useState<"model" | "token">("model");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const modelRef = useRef<TextareaRenderable>(null);
  const tokenRef = useRef<TextareaRenderable>(null);

  const provider = PROVIDERS[providerIndex]!;
  const isCloud = provider.kind === "Cloud";

  const submit = useCallback(async () => {
    if (saving) return;

    const id = modelRef.current?.plainText.trim() || modelName.trim();
    const apiToken = tokenRef.current?.plainText.trim() || token.trim();

    if (!id) {
      setError("Model name is required");
      return;
    }

    if (isCloud && !apiToken) {
      setError("A token is required for cloud models");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await appClient.models.$post({
        json: {
          id,
          provider: provider.id,
          ...(isCloud ? { token: apiToken } : {}),
        },
      });

      if (!response.ok) {
        const body = await response.json();
        throw new Error("error" in body ? body.error : "Failed to add model");
      }

      onCreated(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add model");
    } finally {
      setSaving(false);
    }
  }, [isCloud, modelName, onCreated, provider.id, saving, token]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      onCancel();
      return;
    }

    if (key.name === "left" || key.name === "right") {
      const delta = key.name === "left" ? -1 : 1;
      setProviderIndex((index) => (index + delta + PROVIDERS.length) % PROVIDERS.length);
      return;
    }

    if (key.name === "tab") {
      key.preventDefault();
      setActiveField((field) => (field === "model" ? "token" : "model"));
      return;
    }

    if ((key.name === "return" || key.name === "enter") && !key.shift) {
      key.preventDefault();
      void submit();
    }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.DIM}>Add a model</text>

      <box flexDirection="row" justifyContent="space-between">
        <text>Provider</text>
        <text fg={colors.primary}>
          {provider.label} ({provider.kind})  ← →
        </text>
      </box>

      <box flexDirection="column" gap={0.5}>
        <text>Model name</text>
        <textarea
          ref={modelRef}
          focused={activeField === "model"}
          width="100%"
          height={1}
          value={modelName}
          placeholder="e.g. gpt-4.1"
          onContentChange={() => setModelName(modelRef.current?.plainText ?? "")}
        />
      </box>

      {isCloud && (
        <box flexDirection="column" gap={0.5}>
          <text>API token</text>
          <textarea
            ref={tokenRef}
            focused={activeField === "token"}
            width="100%"
            height={1}
            value={token}
            placeholder="Paste your provider token"
            onContentChange={() => setToken(tokenRef.current?.plainText ?? "")}
          />
          <text attributes={TextAttributes.DIM}>The token is written to the local .env and is never stored in Git.</text>
        </box>
      )}

      {error && <text fg={colors.error}>{error}</text>}

      <box flexDirection="row" justifyContent="space-between" marginTop={1}>
        <text attributes={TextAttributes.DIM}>esc cancel</text>
        <text fg={colors.primary}>{saving ? "Saving..." : "enter save"}</text>
      </box>
    </box>
  );
}
