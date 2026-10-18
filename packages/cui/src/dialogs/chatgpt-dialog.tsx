import { useCallback, useEffect, useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { DialogSearchList } from "../components/dialog-search-list";
import { appClient } from "../lib/api-client";
import { openBrowser } from "../lib/open-browser";
import { useTheme } from "../providers/theme";

type Account = { id: string; label: string; connected: boolean; active: boolean };
type Props = { onBack: () => void; onConnected: () => void };

export function ChatGPTDialogContent({ onBack, onConnected }: Props) {
    const [enabled, setEnabled] = useState(false);
    const { colors } = useTheme();
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [message, setMessage] = useState("");
    const [waiting, setWaiting] = useState(false);
    const [url, setURL] = useState("");
    const attempt = useRef<string | null>(null);
    const alive = useRef(true);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const busy = useRef(false);
    const controller = useRef(new AbortController());
    const options = () => ({ init: { signal: controller.current.signal } });

    const load = useCallback(async () => {
        const response = await appClient.chatgpt.$get(undefined, options());
        if (!response.ok) throw new Error("Não foi possível consultar a conexão ChatGPT.");
        const data = await response.json();
        setEnabled(data.enabled !== false);
        if (alive.current && "accounts" in data) setAccounts(data.accounts);
    }, []);
    useEffect(() => {
        alive.current = true;
        controller.current = new AbortController();
        void load().catch(() => { if (alive.current) setMessage("Não foi possível consultar a conexão ChatGPT."); });
        return () => {
            alive.current = false; clearTimeout(timer.current);
            controller.current.abort();
            if (attempt.current) void appClient.chatgpt.login[":id"].$delete({ param: { id: attempt.current } }).catch(() => {});
        };
    }, [load]);

    const refresh = async () => {
        const response = await appClient.chatgpt.models.$post(undefined, options());
        if (!response.ok) throw new Error("Não foi possível consultar os modelos. Confira a permissão de usar o plano ChatGPT.");
        const result = await response.json();
        if ("models" in result && result.models.length === 0) throw new Error("Nenhum modelo disponível para essa conta ChatGPT.");
        if (alive.current) onConnected();
    };
    const connect = async (accountId?: string) => {
        if (busy.current) return;
        busy.current = true; setWaiting(true); setMessage("Conclua o login e autorize o uso do plano no navegador.");
        try {
            const response = await appClient.chatgpt.login.$post({ json: accountId ? { accountId } : {} }, options());
            if (!response.ok) throw new Error("Não foi possível iniciar o login ChatGPT.");
            const data = await response.json();
            if (!("authorizationUrl" in data)) throw new Error("Resposta de login inválida.");
            if (!alive.current) { await appClient.chatgpt.login[":id"].$delete({ param: { id: data.id } }); return; }
            attempt.current = data.id;
            try { await openBrowser(data.authorizationUrl); }
            catch { if (alive.current) setURL(data.authorizationUrl); }
            const poll = async () => {
                if (!alive.current || !attempt.current) return;
                try {
                    const status = await appClient.chatgpt.login[":id"].$get({ param: { id: data.id } }, options());
                    if (!status.ok) throw new Error("Não foi possível acompanhar o login ChatGPT.");
                    const result = await status.json();
                    if (!("status" in result)) throw new Error("Resposta de login inválida.");
                    if (result.status === "complete") {
                        attempt.current = null; busy.current = false;
                        await refresh();
                    } else if (result.status === "error") throw new Error(result.message ?? "Login não concluído.");
                    else if (alive.current) timer.current = setTimeout(() => { void poll(); }, 1000);
                } catch (error) {
                    if (attempt.current) void appClient.chatgpt.login[":id"].$delete({ param: { id: data.id } }).catch(() => {});
                    attempt.current = null; busy.current = false;
                    if (alive.current) { setWaiting(false); setURL(""); setMessage(error instanceof Error ? error.message : "Falha no login ChatGPT."); void load(); }
                }
            };
            if (alive.current) void poll();
        } catch (error) {
            busy.current = false;
            if (alive.current) { setWaiting(false); setMessage(error instanceof Error ? error.message : "Falha no login ChatGPT."); }
        }
    };
    const action = async (operation: () => Promise<void>) => {
        if (busy.current) return;
        busy.current = true;
        try { await operation(); }
        catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "Não foi possível atualizar a conexão."); }
        finally { busy.current = false; }
    };
    const items = [
        { id: "back", text: "Voltar aos modelos", run: async () => { onBack(); } },
        { id: "new", text: "Continuar com ChatGPT · adicionar conta", run: async () => { await connect(); } },
        ...accounts.flatMap(account => [
            { id: `connect:${account.id}`, text: `${account.label} · ${account.id.slice(-8)} · ${account.active ? "usando plano ChatGPT" : account.connected ? "selecionar" : "reconectar"}`, run: async () => {
                if (!account.connected) { await connect(account.id); return; }
                await action(async () => {
                    const response = await appClient.chatgpt.accounts[":id"].activate.$post({ param: { id: account.id } }, options());
                    if (!response.ok) throw new Error("Não foi possível selecionar a conta.");
                    await refresh();
                });
            } },
            ...(account.connected ? [{ id: `logout:${account.id}`, text: `Desconectar ${account.label} · ${account.id.slice(-8)}`, run: async () => {
                await action(async () => {
                    const response = await appClient.chatgpt.accounts[":id"].$delete({ param: { id: account.id } }, options());
                    if (!response.ok) throw new Error("Não foi possível desconectar a conta.");
                    const result = await response.json();
                    setMessage("revoked" in result && result.revoked ? "Conta desconectada." : "Conta desconectada localmente. Revogação remota não confirmada; confira as configurações do ChatGPT.");
                    await load();
                });
            } }] : []),
        ]),
        { id: "usage", text: "Gerenciar uso do plano ChatGPT", run: async () => { await action(() => openBrowser("https://chatgpt.com/settings/usage")); } },
    ];
    if (!enabled) return <box flexDirection="column" gap={1}>
        <text>Login ChatGPT desativado por padrão.</text>
        <text>Para habilitar, defina MYAGENT_ENABLE_CHATGPT=1 e reinicie o myagent.</text>
        <text onMouseDown={onBack}>Esc: fechar · clique para voltar</text>
    </box>;
    return <box flexDirection="column" gap={1}>
        <text attributes={TextAttributes.BOLD}>Conectar ChatGPT</text>
        <text attributes={TextAttributes.DIM}>Use seu plano elegível. O uso respeita os limites da conta.</text>
        {message && <text fg={colors.primary}>{message}</text>}
        {url && <text>{url}</text>}
        {waiting ? <text attributes={TextAttributes.DIM}>Aguardando autorização · Esc cancela</text> : <DialogSearchList
            items={items} onSelect={item => { void item.run(); }} getKey={item => item.id}
            filterFn={(item, query) => item.text.toLowerCase().includes(query.toLowerCase())}
            renderItem={item => <text>{item.text}</text>} placeholder="Buscar contas e ações..."
        />}
    </box>;
}
