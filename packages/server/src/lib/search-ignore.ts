import { relative } from "node:path";
import { readProjectText } from "./project-inspection";
import { PathNotFoundError } from "../utils/path";

const FIXED_IGNORES = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const MAX_RULES = 2_000;

function trimTrailingSpaces(line: string): string {
    let end = line.length;
    while (line[end - 1] === " ") {
        let escapes = 0;
        for (let index = end - 2; index >= 0 && line[index] === "\\"; index--) escapes++;
        if (escapes % 2) break;
        end--;
    }
    return line.slice(0, end);
}

// Git trata chaves/parênteses como literais, enquanto Bun.Glob também tem extensões.
function gitPattern(pattern: string): string | undefined {
    let result = "";
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index]!;
        if (char === "\\") {
            if (++index === pattern.length) return undefined;
            result += "\\" + pattern[index]!;
        } else if (char === "*") {
            let end = index;
            while (pattern[end + 1] === "*") end++;
            const globstar = end - index === 1 && (index === 0 || pattern[index - 1] === "/")
                && (end === pattern.length - 1 || pattern[end + 1] === "/");
            result += globstar ? "**" : "*";
            index = end;
        } else result += "{}()".includes(char) ? "\\" + char : char;
    }
    return result;
}

/** Regras somente da raiz do workspace; não lê configuração global nem segue links. */
export async function loadSearchIgnore(cwd: string, signal?: AbortSignal) {
    let text = "";
    try { text = (await readProjectText(cwd, ".gitignore", signal, 65_536)).text; }
    catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof PathNotFoundError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rules: { glob: Bun.Glob; negated: boolean; directoryOnly: boolean; anchored: boolean }[] = [];
    for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
        signal?.throwIfAborted();
        let pattern = trimTrailingSpaces(raw);
        if (!pattern || pattern.startsWith("#")) continue;
        const negated = pattern.startsWith("!");
        if (negated) pattern = pattern.slice(1);
        const directoryOnly = pattern.endsWith("/");
        if (directoryOnly) pattern = pattern.slice(0, -1);
        const anchored = pattern.includes("/");
        if (pattern.startsWith("/")) pattern = pattern.slice(1);
        const compiled = gitPattern(pattern);
        if (!compiled) continue;
        if (rules.length >= MAX_RULES) throw new Error("GITIGNORE_TOO_LARGE: mais de 2000 regras na raiz.");
        rules.push({ glob: new Bun.Glob(compiled), negated, directoryOnly, anchored });
    }
    return (file: string, isDirectory: boolean): boolean => {
        const path = relative(cwd, file).replaceAll("\\", "/");
        if (!path) return false;
        const parts = path.split("/");
        let prefix = "";
        for (const [index, part] of parts.entries()) {
            if (FIXED_IGNORES.has(part)) return true;
            prefix += (prefix ? "/" : "") + part;
            const directory = index < parts.length - 1 || isDirectory;
            let ignored = false;
            for (const rule of rules) {
                if (rule.directoryOnly && !directory) continue;
                if (rule.glob.match(rule.anchored ? prefix : part)) ignored = !rule.negated;
            }
            // Um filho não pode ser reincluído enquanto o diretório pai estiver excluído.
            if (ignored) return true;
        }
        return false;
    };
}
