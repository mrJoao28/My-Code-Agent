import { getErrorMessage } from "../lib/http-errors";
import { SecretInput } from "../components/secret-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { TextAttributes, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../providers/dialog";
import { useTheme } from "../providers/theme";
import { DialogSearchList } from "../components/dialog-search-list";
import { appClient } from "../lib/api-client";
import type { SupportedProvider } from "@myagent/shared";
import { ChatGPTDialogContent } from "./chatgpt-dialog";

type Model = { id: string; displayName?: string; provider: SupportedProvider; configured: boolean; contextWindow?: number; contextWindowEstimated?: boolean };
type Props = { onSelectModel: (modelId: string) => void };

const PROVIDERS: { id: Exclude<SupportedProvider, "chatgpt">; label: string; kind: "Cloud" | "Local" }[] = [
  { id: "ollama", label: "Ollama", kind: "Local" },
  { id: "anthropic", label: "Anthropic", kind: "Cloud" },
  { id: "openai", label: "OpenAI", kind: "Cloud" },
  { id: "google", label: "Google", kind: "Cloud" },
];

export const ModelDialogContent = ({ onSelectModel }: Props) => {
  const dialog = useDialog();
  const [models, setModels] = useState<Model[]>([]);
  const [loadError, setLoadError] = useState("");
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<Model | null>(null);
  const [connecting, setConnecting] = useState(false);

  const loadModels = useCallback(async () => {
    try {
      const response = await appClient.models.$get();
      if (!response.ok) throw new Error(await getErrorMessage(response));
      setModels((await response.json()) as Model[]); setLoadError("");
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Não foi possível carregar models.json."); }
  }, []);

  useEffect(() => { void loadModels(); }, [loadModels]);

  const select = useCallback((model: Model) => {
    if (model.provider === "chatgpt" && !model.configured) { setConnecting(true); return; }
    if (model.provider !== "ollama" && !model.configured) {
      setConfiguring(model);
      return;
    }
    onSelectModel(model.id);
    dialog.close();
  }, [dialog, onSelectModel]);

  if (connecting) return <ChatGPTDialogContent onBack={() => { setConnecting(false); void loadModels(); }} onConnected={() => { setConnecting(false); void loadModels(); }} />;

  if (adding) {
    return (
      <AddModelForm
        onCreated={(id) => { onSelectModel(id); dialog.close(); }}
        onCancel={() => setAdding(false)}
      />
    );
  }

  if (configuring) {
    return (
      <ConfigureKeyForm
        model={configuring}
        onConfigured={() => { onSelectModel(configuring.id); dialog.close(); }}
        onCancel={() => setConfiguring(null)}
      />
    );
  }

  const addItem: Model = { id: "__add_model__", provider: "ollama", configured: true };
  const connectItem: Model = { id: "__chatgpt__", provider: "chatgpt", configured: true };
  const items = [connectItem, addItem, ...models];

  return (
    <box flexDirection="column">
    {loadError && <text fg="red">{loadError}</text>}
    <DialogSearchList
      items={items}
      onSelect={(item) => item.id === connectItem.id ? setConnecting(true) : item.id === addItem.id ? setAdding(true) : select(item)}
      filterFn={(item, query) => item.id === addItem.id || item.id === connectItem.id || `${item.id} ${item.displayName ?? ""}`.toLowerCase().includes(query.toLowerCase())}
      renderItem={(item, selected) => (
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text fg={selected ? "black" : undefined} flexShrink={1}>
            {item.id === connectItem.id ? "Continuar com ChatGPT / gerenciar contas" : item.id === addItem.id ? "+ Adicionar modelo local / API key" : item.displayName ?? item.id}
          </text>
          {item.id !== addItem.id && item.id !== connectItem.id && (
            <text attributes={TextAttributes.DIM} flexShrink={0}>
              {item.contextWindow ? `${item.contextWindow} tokens${item.contextWindowEstimated ? " (estimada)" : ""}` : item.provider === "chatgpt" ? "plano ChatGPT" : item.provider === "ollama" ? "local" : item.configured ? "ready" : "API key required"}
            </text>
          )}
        </box>
      )}
      getKey={(item) => item.id}
      placeholder="Search models..."
      emptyText="No models found"
    />
    </box>
  );
};

type AddModelFormProps = { onCreated: (id: string) => void; onCancel: () => void };

function AddModelForm({ onCreated, onCancel }: AddModelFormProps) {
  const { colors } = useTheme();
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelName, setModelName] = useState("");
  const [token, setToken] = useState("");
  const tokenValue = useRef("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [field, setField] = useState<"model" | "token">("model");
  const modelRef = useRef<TextareaRenderable>(null);
  const provider = PROVIDERS[providerIndex]!;
  const isCloud = provider.kind === "Cloud";

  const submit = useCallback(async () => {
    if (saving) return;
    const id = modelRef.current?.plainText.trim() || modelName.trim();
    const apiToken = tokenValue.current.trim();
    if (!id) return setError("Model name is required");
    if (isCloud && !apiToken) return setError("API key is required for cloud models");

    setSaving(true); setError(null);
    try {
      const response = await appClient.models.$post({
        json: { id, provider: provider.id, ...(isCloud ? { token: apiToken } : {}) },
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("error" in body && typeof body.error === "string" ? body.error : "Could not add model");
      }
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add model");
    } finally { setSaving(false); }
  }, [isCloud, modelName, onCreated, provider.id, saving, token]);

  useKeyboard((key) => {
    if (key.name === "escape") { key.preventDefault(); onCancel(); return; }
    if (key.name === "tab" && isCloud) { key.preventDefault(); setField(value => value === "model" ? "token" : "model"); return; }
    if (key.name === "left" || key.name === "right") {
      const delta = key.name === "left" ? -1 : 1;
      setProviderIndex(i => (i + delta + PROVIDERS.length) % PROVIDERS.length);
      setField("model");
      return;
    }
    if ((key.name === "return" || key.name === "enter") && !key.shift) { key.preventDefault(); void submit(); }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD}>Add model</text>
      <text attributes={TextAttributes.DIM}>Choose a provider and enter the model identifier.</text>
      <box flexDirection="row" justifyContent="space-between">
        <text>Provider</text><text fg={colors.primary}>{provider.label} · {provider.kind}  ← →</text>
      </box>
      <box flexDirection="column" gap={0.5}>
        <text>Model</text>
        <textarea ref={modelRef} focused={field === "model"} width="100%" height={1} initialValue={modelName} placeholder={isCloud ? "e.g. gpt-4.1" : "ex.: qwen2.5-coder:7b"} onContentChange={() => setModelName(modelRef.current?.plainText ?? "")} />
      </box>
      {isCloud && (
        <box flexDirection="column" gap={0.5}>
          <text>API key</text>
          <SecretInput value={token} onChange={value => { tokenValue.current = value; setToken(value); }} focused={field === "token"} />
          <text attributes={TextAttributes.DIM}>Salva em ~/.myagent/config.env (ou MYAGENT_HOME), sem retorno pela API.</text>
        </box>
      )}
      {error && <text fg={colors.error}>{error}</text>}
      <text attributes={TextAttributes.DIM}>{saving ? "Saving..." : "Enter save · Tab field · Esc cancel"}</text>
    </box>
  );
}

type ConfigureKeyProps = { model: Model; onConfigured: () => void; onCancel: () => void };

function ConfigureKeyForm({ model, onConfigured, onCancel }: ConfigureKeyProps) {
  const { colors } = useTheme();
  const [token, setToken] = useState("");
  const tokenValue = useRef("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = useCallback(async () => {
    const value = tokenValue.current.trim();
    if (!value) return setError("API key is required");
    setSaving(true); setError(null);
    try {
      const response = await appClient.models[":id"].key.$post({
        param: { id: encodeURIComponent(model.id) }, json: { token: value },
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("error" in body && typeof body.error === "string" ? body.error : "Could not save API key");
      }
      onConfigured();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save API key");
    } finally { setSaving(false); }
  }, [model.id, onConfigured, token]);

  useKeyboard((key) => {
    if (key.name === "escape") { key.preventDefault(); onCancel(); return; }
    if ((key.name === "return" || key.name === "enter") && !key.shift) { key.preventDefault(); void submit(); }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD}>API key required</text>
      <text>Configure a key before using:</text>
      <text fg={colors.primary}>{model.id}</text>
      <SecretInput value={token} onChange={value => { tokenValue.current = value; setToken(value); }} />
      <text attributes={TextAttributes.DIM}>A chave fica em ~/.myagent/config.env (ou MYAGENT_HOME).</text>
      {error && <text fg={colors.error}>{error}</text>}
      <text attributes={TextAttributes.DIM}>{saving ? "Saving..." : "Enter save · Esc cancel"}</text>
    </box>
  );
}
