import type { ChatStreamEvent } from "@myagent/shared";
type Approval = Extract<ChatStreamEvent, { type: "approval-required" }>;
export type PreviewLine = { text: string; color?: "green" | "red" | "cyan" };
export function approvalPreview(approval: Approval): PreviewLine[] {
    const args = approval.args;
    const rows = (text: string): string[] => {
        const visible = text.slice(0, 80_000).split(/\r?\n/);
        const limited = text.length > 80_000 || visible.length > 1000;
        return [...visible.slice(0, 1000), ...(limited ? ["Prévia limitada a 1000 linhas / 80 mil caracteres. Use N e peça uma alteração menor para revisar tudo."] : [])];
    };
    const plain = (text: string): PreviewLine[] => rows(text).map(text => ({ text }));
    const diff = (text: string): PreviewLine[] => rows(text).map(text => ({ text,
        ...(text.startsWith("+") ? { color: "green" as const } : text.startsWith("-") ? { color: "red" as const } : text.startsWith("@@") ? { color: "cyan" as const } : {}) }));
    switch (approval.toolName) {
        case "bash": return plain(`Comando:\n${args.command ?? ""}`);
        case "edit_file": return diff(`--- a/${args.path}\n+++ b/${args.path}\n@@ Substituição proposta @@\n${String(args.old_str ?? "").split(/\r?\n/).map(line => "-" + line).join("\n")}\n${String(args.new_str ?? "").split(/\r?\n/).map(line => "+" + line).join("\n")}`);
        case "apply_patch": return [...plain(args.checkOnly ? "Verificar patch, sem aplicar:" : "Aplicar patch:"), ...diff(String(args.patch ?? ""))];
        case "write_file": {
            const content = String(args.content ?? "");
            return plain(`Arquivo: ${args.path}\nTamanho: ${new TextEncoder().encode(content).byteLength} bytes\nSobrescrever: ${args.overwrite === false ? "não" : "sim"} · Backup .bak: ${args.backup ? "sim" : "não"}\nPrévia do conteúdo:\n${content}`);
        }
        case "web_fetch": return plain(`URL completa:\n${args.url}`);
        case "move_file": return plain(`Origem: ${args.from}\nDestino: ${args.to}\nSobrescrever destino: ${args.overwrite ? "sim" : "não"}`);
        case "delete_file": return plain(`Origem: ${args.path}\nDestino: exclusão (checkpoint antes da ação)\nRecursiva: ${args.recursive ? "sim" : "não"}`);
        case "git_commit": return plain(`Criar commit:\n${args.message ?? ""}\nArquivos: ${JSON.stringify(args.files ?? [])}`);
        case "git_init": return plain("Inicializar Git no workspace com branch main (sem criar commit).");
        case "git_switch": return plain(`${args.create ? "Criar e trocar para" : "Trocar para"} branch: ${args.branch}`);
        case "git_remote_add": return plain(`Adicionar remote: ${args.remote ?? "origin"}\nURL completa: ${args.url}`);
        case "git_push": return plain(`Enviar branch: ${args.branch}\nRemote: ${args.remote ?? "origin"}\nURL completa: ${args.url}\nApós o envio, aguardar liberação do PR no GitHub.`);
        case "git_sync": return plain(`Sincronizar principal: ${args.branch ?? "main"}\nRemote: ${args.remote ?? "origin"}\nURL completa: ${args.url}\nFetch seguido de merge --ff-only, sem resolver conflitos.`);
        case "web_search": return plain(`Busca web:\n${args.query ?? ""}`);
        default: return plain(JSON.stringify(args, null, 2));
    }
}
