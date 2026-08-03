import { useCallback, useEffect, useRef, useState } from "react";
import { TextAttributes, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../providers/dialog";
import { useTheme } from "../providers/theme";
import { DialogSearchList } from "../components/dialog-search-list";
import { appClient } from "../lib/api-client";
import type { SupportedProvider } from "@myagent/shared";

type Model = {
  id: string;
  provider: SupportedProvider;
  configured: boolean;
};

type Props = { onSelectModel: (modelId: string) => void };

const PROVIDERS: { id: SupportedProvider; label: string; kind: "Cloud" | "Local" }[] = [
  { id: "anthropic", label: "Anthropic", kind: "Cloud" },
  { id: "openai", label: "OpenAI", kind: "Cloud" },
  { id: "google", label: "Google", kind: "Cloud" },
  { id: "ollama", label: "Ollama", kind: "Local" },
];

export const ModelDialogContent = ({ onSelectModel }: Props) => {
  const dialog = useDialog();
  const [models, setModels] = useState<Model[]>([]);
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<Model | null>(null);

  const loadModels = useCallback(async () => {
    try {
      const response = await appClient.models.$get();
      if (!response.ok) return;
      const data = await response.json();
      setModels(data as Model[]);
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const select = useCallback((model: Model) => {
    if (model.provider !== "ollama" && !model.configured) {
      setConfiguring(model);
      return;
    }
    onSelectModel(model.id);
    dialog.close();
  }, [dialog, onSelectModel]);

  if (adding) {
    return <AddModelForm onCreated={onCreated => { onSelectModel(onCreated); dialog.close(); }} onCancel={() => setAdding(false)} />;
  }

  if (configuring) {
    return (
      <ConfigureKeyForm
        model={configuring}
        onConfigured={() => {
          onSelectModel(configuring.id);
          dialog.close();
        }}
        onCancel={() => setConfiguring(null)}
      />
    );
  }

  const items = [{ id: "__add_model__", provider: "ollama" as const, configured: true }, ...models];

  return (
    <DialogSearchList
      items={items}
      onSelect={(item) => item.id === "__add_model__" ? setAdding(true) : select(item)}
      filterFn={(item, query) => item.id === "__add_model__" || item.id.toLowerCase().includes(query.toLowerCase())}
      renderItem={(item, selected) => (
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text fg={selected ? "black" : undefined}>
            {item.id === "__add_model__" ? "+ Add model" : item.id}
          </text>
          {item.id !== "__add_model__" && (
            <text attributes={TextAttributes.DIM}>
              {item.provider === "ollama" ? "local" : item.configured ? "configured" : "API key required"}
            </text>
          )}
        </box>
      )}
      getKey={(item) => item.id}
      placeholder="Search models..."
      emptyText="No models found"
    />
  );
};

type AddModelFormProps = { onCreated: (id: string) => void; onCancel: () => void };

function AddModelForm({ onCreated, onCancel }: AddModelFormProps) {
  const { colors } = useTheme();
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelName, setModelName] = useState("");
  const [token, setToken] = useState("");
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
    if (!id) return setError("Model name is required");
    if (isCloud && !apiToken) return setError("API key is required for cloud models");

    setSaving(true);
    setError(null);
    try {
      const response = await appClient.models.$post({
        json: { id, provider: provider.id, ...(isCloud ? { token: apiToken } : {}) },
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("error" in body ? body.error : "Could not add model");
      }
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add model");
    } finally {
      setSaving(false);
    }
  }, [isCloud, modelName, onCreated, provider.id, saving, token]);

  useKeyboard((key) => {
    if (key.name === "escape") { key.preventDefault(); onCancel(); }
    if (key.name === "left" || key.name === "right") {
      const delta = key.name === "left" ? -1 : 1;
      setProviderIndex(i => (i + delta + PROVIDERS.length) % PROVIDERS.length);
    }
    if ((key.name === "return" || key.name === "enter") && !key.shift) {
      key.preventDefault(); void submit();
    }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD}>Add model</text>
      <text attributes={TextAttributes.DIM}>Choose a provider, then enter the model identifier.</text>

      <box flexDirection="row" justifyContent="space-between">
        <text>Provider</text>
        <text fg={colors.primary}>{provider.label} · {provider.kind}  ← →</text>
      </box>

      <box flexDirection="column" gap={0.5}>
        <text>Model</text>
        <textarea ref={modelRef} width="100%" height={1} value={modelName} placeholder="e.g. gpt-4.1" onContentChange={() => setModelName(modelRef.current?.plainText ?? "")} />
      </box>

      {isCloud && (
        <box flexDirection="column" gap={0.5}>
          <text>API key</text>
          <textarea ref={tokenRef} width="100%" height={1} value={token} placeholder="Required to use this model" onContentChange={() => setToken(tokenRef.current?.plainText ?? "")} />
          <text attributes={TextAttributes.DIM}>Saved locally in .env. It is never returned by the API.</text>
        </box>
      )}

      {error && <text fg={colors.error}>{error}</text>}
      <text attributes={TextAttributes.DIM}>{saving ? "Saving..." : "Enter save · Esc cancel"}</text>
    </box>
  );
}

type ConfigureKeyProps = { model: Model; onConfigured: () => void; onCancel: () => void };

function ConfigureKeyForm({ model, onConfigured, onCancel }: ConfigureKeyProps) {
  const { colors } = useTheme();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<TextareaRenderable>(null);

  const submit = useCallback(async () => {
    const value = ref.current?.plainText.trim() || token.trim();
    if (!value) return setError("API key is required");
    setSaving(true);
    try {
      const response = await appClient.models[":id"].key.$post({
        param: { id: encodeURIComponent(model.id) },
        json: { token: value },
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("error" in body ? body.error : "Could not save API key");
      }
      onConfigured();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save API key");
    } finally {
      setSaving(false);
    }
  }, [model.id, onConfigured, token]);

  useKeyboard((key) => {
    if (key.name === "escape") { key.preventDefault(); onCancel(); }
    if ((key.name === "return" || key.name === "enter") && !key.shift) { key.preventDefault(); void submit(); }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD}>API key required</text>
      <text>Configure a key before using {model.id}.</text>
      <textarea ref={ref} width="100%" height={1} value={token} placeholder="Paste API key" onContentChange={() => setToken(ref.current?.plainText ?? "")} />
      {error && <text fg={colors.error}>{error}</text>}
      <text attributes={TextAttributes.DIM}>{saving ? "Saving..." : "Enter save · Esc cancel"}</text>
    </box>
  );
}
