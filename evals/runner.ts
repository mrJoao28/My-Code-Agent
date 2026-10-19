import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadGlobalConfig } from "../packages/server/src/lib/env";
import { findModel, getCustomModels, isModelConfigured } from "../packages/server/src/lib/model-registry";
import { writeModelConfig } from "../packages/server/src/lib/model-config";
import type { ExecResult } from "../packages/myagent/src/exec";
import { createHash } from "node:crypto";
import { SIMULATED_MODELS, startSimulation } from "./simulation";
import { removeEvalRoot } from "./cleanup";
import { runProcess } from "../packages/server/src/security/sandbox";
import { gitEnvironment } from "../packages/server/src/utils/git";
import { prepareTask, tasks, verifyTask } from "./tasks";

export type EvalRow = { model: string; task: string; passed: boolean; reason: string; toolCalls: number; totalTokens: number | null; durationMs: number; exitCode: number };
export function comparison(rows: EvalRow[]): string {
    const lines = ["| Modelo | Sucesso | Ferramentas | Tokens | Tempo (s) |", "|---|---:|---:|---:|---:|"];
    for (const model of new Set(rows.map(row => row.model))) {
        const group = rows.filter(row => row.model === model);
        const knownTokens = group.filter(row => row.totalTokens !== null).reduce((sum, row) => sum + row.totalTokens!, 0);
        const tokens = group.every(row => row.totalTokens !== null) ? String(knownTokens) : `${knownTokens} + não informado`;
        lines.push(`| ${model.replace(/\|/g, "\\|")} | ${group.filter(row => row.passed).length}/${group.length} (${Math.round(100 * group.filter(row => row.passed).length / group.length)}%) | ${group.reduce((sum, row) => sum + row.toolCalls, 0)} | ${tokens} | ${(group.reduce((sum, row) => sum + row.durationMs, 0) / 1000).toFixed(1)} |`);
    }
    return lines.join("\n");
}
export function parseEvalOptions(args: string[]) {
    const models: string[] = [], selected: string[] = [];
    let simulate = false, bundle = false;
    let output = resolve("evals/results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === "--simulate") { simulate = true; continue; }
        if (flag === "--bundle") { bundle = true; continue; }
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error("Uso: bun run eval --model ID [--model OUTRO] [--task ID] [--output arquivo.json]");
        if (flag === "--model") models.push(value);
        else if (flag === "--task" && tasks.some(task => task.id === value)) selected.push(value);
        else if (flag === "--output") output = resolve(value);
        else throw new Error(`Opção inválida: ${flag}`);
    }
    if (simulate && !models.length) models.push(...SIMULATED_MODELS);
    if (!models.length || new Set(models).size !== models.length) throw new Error("Informe --model ID, sem repetir o mesmo modelo.");
    if (simulate && models.some(model => !SIMULATED_MODELS.includes(model))) throw new Error("--simulate aceita somente simulado-a e simulado-b.");
    return { models, selected, output, simulate, bundle };
}

export async function runEvaluations(args: string[]) {
    const options = parseEvalOptions(args);
    if (!options.simulate) loadGlobalConfig();
    const customModels = options.simulate ? SIMULATED_MODELS.map(id => ({ id, provider: "ollama" as const, contextWindow: 200_000, pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } })) : getCustomModels();
    for (const model of options.models) {
        if (options.simulate) continue;
        const definition = findModel(model);
        if (!definition) throw new Error(`Modelo não encontrado: ${model}`);
        if (!isModelConfigured(model)) throw new Error(`Configure a chave do modelo ${model} antes da avaliação.`);
        if (definition.provider === "chatgpt") throw new Error("Evals isoladas não copiam credenciais de login ChatGPT. Use um modelo de API ou Ollama.");
    }
    const selectedTasks = tasks.filter(task => !options.selected.length || options.selected.includes(task.id));
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("Avaliação cancelada."));
    const rows: EvalRow[] = [];
    const cleanupFailures: { directory: string; code: string }[] = [];
    const cli = fileURLToPath(new URL(options.bundle ? "../packages/myagent/dist/cli.js" : "../packages/myagent/src/cli.ts", import.meta.url));
    if (!await Bun.file(cli).exists()) throw new Error("CLI não encontrada. Execute bun run build antes de usar --bundle.");
    const fingerprint = createHash("sha256").update(JSON.stringify(selectedTasks)).digest("hex");
    const report = { version: 1, realProviders: !options.simulate, entrypoint: options.bundle ? "bundle" : "source", createdAt: new Date().toISOString(), platform: process.platform, fixtureHash: fingerprint, tasks: selectedTasks.map(task => task.id), rows, cleanupFailures };
    await mkdir(dirname(options.output), { recursive: true });
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    try {
        for (const task of selectedTasks) for (const model of options.models) {
            controller.signal.throwIfAborted();
            const root = await mkdtemp(join(tmpdir(), "myagent-eval-"));
            const cwd = join(root, "workspace"), home = join(root, "global");
            // Libera referências aos subprocessos antes da limpeza em Windows.
            await (async () => {
            let child: ReturnType<typeof Bun.spawn> | undefined;
            let simulation: ReturnType<typeof startSimulation> | undefined;
            const calls: { toolName: string; args: Record<string, unknown> }[] = [];
            let final: ExecResult | undefined;
            let protocolError: string | undefined;
            const started = performance.now();
            let stderr = "";
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            let abortTimer: ReturnType<typeof setTimeout> | undefined;
            const abort = () => {
                child?.kill("SIGINT");
                killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 15_000);
            };
            try {
                await prepareTask(task, cwd);
                const git = await runProcess("git", ["init", "--quiet", cwd], { timeoutMs: 15_000, signal: controller.signal, env: gitEnvironment() });
                if (git.exitCode !== 0 || git.timedOut) throw new Error("Não foi possível iniciar o repositório temporário dentro do prazo.");
                await mkdir(home, { recursive: true, mode: 0o700 });
                writeModelConfig(join(home, "models.json"), customModels);
                const prompt = `${task.prompt}\nNão faça commits, não instale dependências nem use a rede. Não crie documentação além da solicitada.`;
                if (options.simulate) simulation = startSimulation(task, model);
                // --cwd muda o diretório dentro do filho; o Bun pai não precisa
                // abrir o diretório temporário como cwd de CreateProcess.
                child = Bun.spawn([process.execPath, "--cwd", cwd, cli, "exec", prompt, "--model", model, "--json", ...(task.expected ? ["--mode", "build", "--approve", "all"] : [])], {
                    env: { ...process.env, MYAGENT_HOME: home, MYAGENT_WORKSPACE_ROOTS: JSON.stringify([cwd]), ...(simulation && { OLLAMA_BASE_URL: simulation.url, OLLAMA_API_KEY: simulation.token }) }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
                });
                controller.signal.addEventListener("abort", abort, { once: true });
                if (controller.signal.aborted) abort();
                // O servidor já limita a geração; este prazo também cobre a inicialização.
                abortTimer = setTimeout(abort, 7 * 60_000);
                const errors = (async () => {
                    for await (const chunk of child!.stderr as ReadableStream<Uint8Array>) {
                        if (stderr.length < 16_384) stderr += new TextDecoder().decode(chunk).slice(0, 16_384 - stderr.length);
                    }
                })();
                const decoder = new TextDecoder();
                let pending = "";
                for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
                    pending += decoder.decode(chunk, { stream: true });
                    if (pending.length > 16 * 1024 * 1024) throw new Error("JSONL excedeu o limite por linha.");
                    let newline: number;
                    while ((newline = pending.indexOf("\n")) !== -1) {
                        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
                        if (!line) continue;
                        try {
                            const event = JSON.parse(line);
                            if (event.type === "tool-call") calls.push({ toolName: event.toolName, args: event.args });
                            if (event.type === "exec-result") { if (final) throw new Error("Resultado duplicado."); final = event; }
                        } catch { protocolError = "JSONL inválido ou resultado final duplicado."; }
                    }
                }
                pending += decoder.decode();
                if (pending.trim()) protocolError = "JSONL terminou sem quebra de linha.";
                const exitCode = await child.exited;
                await errors;
                const verdict = await verifyTask(task, cwd, final?.text ?? "", calls);
                const passed = !protocolError && exitCode === 0 && final?.status === "success" && verdict.passed;
                rows.push({ model, task: task.id, passed, reason: protocolError ?? (exitCode !== 0 || final?.status !== "success" ? final?.error ?? "Execução não concluída; consulte a configuração do provedor." : verdict.reason), toolCalls: final?.toolCalls ?? calls.length, totalTokens: final?.totalTokens ?? null, durationMs: Math.round(performance.now() - started), exitCode });
            } catch (error) {
                rows.push({ model, task: task.id, passed: false, reason: error instanceof Error ? error.message : "Falha da avaliação.", toolCalls: calls.length, totalTokens: final?.totalTokens ?? null, durationMs: Math.round(performance.now() - started), exitCode: 1 });
            } finally {
                controller.signal.removeEventListener("abort", abort);
                if (abortTimer) clearTimeout(abortTimer);
                if (killTimer) clearTimeout(killTimer);
                if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
                child = undefined;
                await simulation?.stop();
                simulation = undefined;
                if (dirname(root) !== tmpdir() || !basename(root).startsWith("myagent-eval-")) throw new Error("Diretório temporário inválido.");
                // Nunca salvar prompts, saídas brutas ou stderr do provedor no relatório.
                stderr = "";
            }
            })();
            Bun.gc(true);
            try { await removeEvalRoot(root); }
            catch (error) {
                cleanupFailures.push({ directory: root, code: (error as NodeJS.ErrnoException).code ?? "CLEANUP_FAILED" });
                console.error(`Aviso: limpeza pendente de ${root}. O relatório preserva o resultado; a avaliação continuará.`);
            }
            const row = rows.at(-1)!;
            console.error(`${model} / ${task.id}: ${row.passed ? "PASSOU" : "FALHOU"} — ${row.reason}`);
            await writeFile(options.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
        }
    } finally {
        process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
        // Diretórios ocupados durante uma tarefa podem já ter sido liberados
        // quando todos os subprocessos e providers da execução terminaram.
        for (let i = cleanupFailures.length - 1; i >= 0; i--) {
            try {
                await removeEvalRoot(cleanupFailures[i]!.directory);
                console.error(`Limpeza recuperada: ${cleanupFailures[i]!.directory}`);
                cleanupFailures.splice(i, 1);
            } catch { /* Mantém o aviso e o código de falha no relatório final. */ }
        }
        await writeFile(options.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
        if (options.simulate) console.log("SIMULAÇÃO — tokens e perfis fictícios; não mede qualidade de modelos reais.");
        console.log(comparison(rows));
        console.error(`Relatório: ${options.output}`);
    }
    return rows.every(row => row.passed) && cleanupFailures.length === 0 ? 0 : 1;
}
if (import.meta.main) runEvaluations(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : "Avaliação falhou."); process.exitCode = 1; });
