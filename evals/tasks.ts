import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";

export type EvalTask = {
    id: string;
    prompt: string;
    files: Record<string, string>;
    expected?: Record<string, string>;
    answer?: string;
    executable?: string;
};
const sumTest = 'import { expect, test } from "bun:test";\nimport { sum } from "./sum";\ntest("sum", () => expect(sum(2, 3)).toBe(5));\n';
const medium = Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`src/module-${i}.ts`, `export const value${i} = ${i};\n`]));
export const tasks: EvalTask[] = [
    { id: "leitura", files: { "README.md": "Código de confirmação: LARANJA-714.\n" }, prompt: "Leia README.md e responda apenas com o código de confirmação. Não altere arquivos.", answer: "LARANJA-714" },
    { id: "corrigir-bug", files: { "src/sum.ts": "export function sum(a: number, b: number) { return a - b; }\n", "src/sum.test.ts": sumTest },
        prompt: "Corrija o operador incorreto em src/sum.ts para somar os argumentos. Preserve a função e os testes; altere somente esse operador.", expected: { "src/sum.ts": "export function sum(a: number, b: number) { return a + b; }\n" } },
    { id: "funcao-com-teste", files: { "README.md": "Projeto Bun TypeScript sem dependências.\n" },
        prompt: 'Crie src/double.ts exportando function double(value: number) que retorna value * 2. Crie src/double.test.ts com import { expect, test } from "bun:test", import { double } from "./double" e test("double", () => expect(double(3)).toBe(6)). Não crie outros arquivos.',
        expected: { "src/double.ts": "export function double(value: number) { return value * 2; }\n", "src/double.test.ts": 'import { expect, test } from "bun:test";\nimport { double } from "./double";\ntest("double", () => expect(double(3)).toBe(6));\n' } },
    { id: "refatorar-crlf", files: { "src/title.ts": "export function title(value: string) {\r\n  const trimmed = value.trim();\r\n  return trimmed.toLowerCase();\r\n}\r\n" },
        prompt: "Em src/title.ts, substitua a declaração de trimmed e o return por uma única linha: return value.trim().toUpperCase(); Preserve a assinatura, o CRLF e todos os demais arquivos. Use edit_file com o trecho de várias linhas.",
        expected: { "src/title.ts": "export function title(value: string) {\r\n  return value.trim().toUpperCase();\r\n}\r\n" } },
    { id: "script-executavel", files: { "bin/greet.sh": '#!/bin/sh\nprintf "%s\\n" "oi"\n' }, executable: "bin/greet.sh",
        prompt: 'Em bin/greet.sh troque somente "oi" por "olá". Preserve o shebang e a permissão de execução; não execute comandos.', expected: { "bin/greet.sh": '#!/bin/sh\nprintf "%s\\n" "olá"\n' } },
    { id: "busca-repositorio", files: { ...medium, "src/module-173.ts": 'export const needle = "ALVO-9327";\n', ".gitignore": "ignored/\n", "ignored/decoy.ts": 'export const needle = "ISCA";\n' },
        prompt: "Encontre a declaração needle nos arquivos src/*.ts usando grep ou symbol_search, sem ler todos os arquivos. Responda com seu valor e caminho. Não altere arquivos.", answer: "ALVO-9327" },
    { id: "instrucoes-agents", files: { "AGENTS.md": "Todas as alterações desta tarefa ficam em src/. Nunca crie RESUME.md ou outros AGENTS.md.\n", "src/AGENTS.md": 'Ao editar arquivos nesta pasta, preserve a primeira linha // regra local.\n', "src/flag.ts": "// regra local\nexport const enabled = false;\n" },
        prompt: "Leia src/flag.ts e altere enabled para true seguindo as instruções do projeto. Altere apenas o literal booleano.", expected: { "src/flag.ts": "// regra local\nexport const enabled = true;\n" } },
    { id: "leitura-longa", files: { "data.txt": Array.from({ length: 300 }, (_, i) => `${i === 149 ? "CENTRO-520" : `registro-${i + 1}`} ${"a".repeat(14)}`).join("\n") + "\n" },
        prompt: "Leia data.txt com read_file e identifique o código na linha 150. Responda com o código, sem alterar arquivos.", answer: "CENTRO-520" },
    { id: "multiplas-leituras", files: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`parts/${String(i + 1).padStart(2, "0")}.txt`, `código-${i + 1}: ${i === 29 ? "FINAL-883" : `item-${i + 1}`}\n`])),
        prompt: "Leia individualmente, usando read_file, os 30 arquivos parts/01.txt até parts/30.txt, em ordem. Não use bash nem read_files. Responda com o código de parts/30.txt. Não altere arquivos.", answer: "FINAL-883" },
];

export async function prepareTask(task: EvalTask, cwd: string) {
    await mkdir(cwd, { recursive: true });
    for (const [path, content] of Object.entries(task.files)) {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), content);
    }
    if (task.executable && process.platform !== "win32") await chmod(join(cwd, task.executable), 0o755);
}
const printer = ts.createPrinter({ removeComments: false });
function canonical(path: string, source: string) {
    if (!path.endsWith(".ts")) return source;
    const parsed = ts.transpileModule(source, { fileName: path, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } });
    if (parsed.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error(`TypeScript inválido: ${path}`);
    return printer.printFile(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true));
}
async function inventory(cwd: string, prefix = ""): Promise<string[]> {
    const result: string[] = [];
    for (const item of await readdir(join(cwd, prefix), { withFileTypes: true })) {
        if (!prefix && item.name === ".git") continue;
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        const info = await lstat(join(cwd, relative));
        if (info.isSymbolicLink() || info.nlink > 1 && info.isFile()) throw new Error(`Link inesperado: ${relative}`);
        if (info.isDirectory()) result.push(...await inventory(cwd, relative));
        else result.push(relative);
        if (result.length > 2000) throw new Error("Mais de 2.000 arquivos no resultado.");
    }
    return result.sort();
}
export async function verifyTask(task: EvalTask, cwd: string, answer: string, calls: { toolName: string; args: Record<string, unknown> }[] = []): Promise<{ passed: boolean; reason: string }> {
    try {
        if (calls.some(call => ["git_commit", "web_search", "web_fetch"].includes(call.toolName))) throw new Error("Uso de Git commit ou rede proibidos pela tarefa.");
        const expected = { ...task.files, ...task.expected };
        if (JSON.stringify(await inventory(cwd)) !== JSON.stringify(Object.keys(expected).sort())) throw new Error("Arquivos criados ou removidos fora do diff esperado.");
        for (const [path, content] of Object.entries(expected)) {
            const info = await lstat(join(cwd, path));
            if (info.size > 256 * 1024) throw new Error(`Arquivo grande demais: ${path}`);
            const actual = await readFile(join(cwd, path), "utf8");
            const changed = path in (task.expected ?? {});
            if ((changed ? canonical(path, actual) : actual) !== (changed ? canonical(path, content) : content)) throw new Error(`Diff inesperado: ${path}`);
            if (content.includes("\r\n") && (actual.replace(/\r\n/g, "").includes("\n") || !actual.includes("\r\n"))) throw new Error(`CRLF perdido: ${path}`);
        }
        if (task.answer && !answer.includes(task.answer)) throw new Error("Resposta não contém o código esperado.");
        if (task.executable && process.platform !== "win32" && ((await lstat(join(cwd, task.executable))).mode & 0o777) !== 0o755) throw new Error("Modo 755 não foi preservado.");
        if (task.id === "busca-repositorio" && !calls.some(call => ["grep", "symbol_search"].includes(call.toolName))) throw new Error("Não utilizou a busca solicitada.");
        if (task.id === "multiplas-leituras") {
            const reads = calls.filter(call => call.toolName === "read_file");
            if (!Array.from({ length: 30 }, (_, i) => `parts/${String(i + 1).padStart(2, "0")}.txt`).every((path, i) => reads[i]?.args.path === path)) throw new Error("Não realizou as 30 leituras individuais em ordem.");
        }
        return { passed: true, reason: task.executable && process.platform === "win32" ? "Diff correto; modo POSIX não verificável no Windows." : "Critério verificado." };
    } catch (error) { return { passed: false, reason: error instanceof Error ? error.message : "Falha no verificador." }; }
}
