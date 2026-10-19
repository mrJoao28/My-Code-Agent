import { randomBytes } from "node:crypto";
import type { EvalTask } from "./tasks";

export const SIMULATED_MODELS = ["simulado-a", "simulado-b"];
type Call = { name: string; args: Record<string, unknown> };

// Roteiros para exercitar o transporte e os verificadores, sem inferência.
// B usa write_file e introduz uma perda de CRLF intencional. Não são modelos.
function script(task: EvalTask, profile: string): Call[] {
    const read = (path: string): Call => ({ name: "read_file", args: { path } });
    const edit = (path: string, old_str: string, new_str: string): Call => ({ name: "edit_file", args: { path, old_str, new_str } });
    const writes = Object.entries(task.expected ?? {}).map(([path, content]) => ({ name: "write_file", args: { path, content: profile === "simulado-b" && task.id === "refatorar-crlf" ? content.replace(/\r\n/g, "\n") : content } }));
    switch (task.id) {
        case "leitura": return [read("README.md")];
        case "corrigir-bug": return profile === "simulado-a" ? [read("src/sum.ts"), edit("src/sum.ts", "a - b", "a + b")] : writes;
        case "funcao-com-teste": return profile === "simulado-a" ? [read("README.md"), ...writes] : writes;
        case "refatorar-crlf": return profile === "simulado-a" ? [read("src/title.ts"), edit("src/title.ts", "  const trimmed = value.trim();\n  return trimmed.toLowerCase();", "  return value.trim().toUpperCase();")] : writes;
        case "script-executavel": return profile === "simulado-a" ? [read("bin/greet.sh"), edit("bin/greet.sh", '"oi"', '"olá"')] : writes;
        case "busca-repositorio": return [{ name: "grep", args: { pattern: "needle", path: "src", include: "*.ts", literal: true } }];
        case "instrucoes-agents": return [read("src/flag.ts"), ...(profile === "simulado-a" ? [edit("src/flag.ts", "false", "true")] : writes)];
        case "leitura-longa": return [{ name: "read_file", args: { path: "data.txt", offset: 0, limit: 300 } }];
        case "multiplas-leituras": return Array.from({ length: 30 }, (_, i) => read(`parts/${String(i + 1).padStart(2, "0")}.txt`));
        default: throw new Error(`Tarefa sem roteiro: ${task.id}`);
    }
}

export function startSimulation(task: EvalTask, profile: string) {
    if (!SIMULATED_MODELS.includes(profile)) throw new Error("Perfil de simulação inválido.");
    const calls = script(task, profile);
    const token = randomBytes(32).toString("hex");
    let step = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 8 * 1024 * 1024, async fetch(request) {
        if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
        if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("Not found", { status: 404 });
        const body = await request.json() as { model: string; messages: { role: string; content: unknown }[] };
        const transcript = JSON.stringify(body.messages);
        if (task.id === "instrucoes-agents" && (!transcript.includes("Todas as alterações desta tarefa ficam em src/") || step > 0 && !transcript.includes("preserve a primeira linha"))) {
            return Response.json({ error: { message: "Instruções do projeto não chegaram ao provider simulado." } }, { status: 400 });
        }
        const call = calls[step++];
        const toolText = body.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content)).join("\n");
        const code = toolText.match(/(?:LARANJA|ALVO|CENTRO|FINAL)-\d+/g)?.at(-1);
        if (!call && task.id === "busca-repositorio" && !code) console.error(`Diagnóstico da busca simulada: ${toolText.slice(0, 2000)}`);
        const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `sim-${step}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
            : { role: "assistant", content: task.answer ? code ?? "Código não recebido pelas ferramentas." : "Alterações concluídas." };
        const base = { id: `eval-${step}`, object: "chat.completion.chunk", created: 0, model: body.model };
        const chunks = [
            { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    } });
    return { url: `http://127.0.0.1:${server.port}/v1`, token, stop: () => server.stop(true) };
}
