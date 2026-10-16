import { tool } from "ai";
import { z } from "zod";
import { basename } from "node:path";
import { projectFiles, packageInfo, inspectionError, isTestFile, limitInspectionOutput } from "../lib/project-inspection";
import { toolDeadline } from "../lib/tool-io";

export function createProjectInspectTool(cwd: string) {
    return tool({
        description: "Inspeção estática do projeto: até 500 caminhos/2 mil entradas, 20 package.json, nomes de scripts/dependências, configs e testes. Não executa configurações ou scripts; não lê segredos. Prazo de 15 segundos.",
        inputSchema: z.object({ path: z.string().max(1_000).optional() }),
        execute: async ({ path }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal);
            try {
                const scan = await projectFiles(cwd, path ?? ".", deadline.signal);
                const manifests = scan.files.filter(p => basename(p) === "package.json"), packages = [], errors = [];
                for (const manifest of manifests.slice(0, 20)) {
                    try { packages.push(await packageInfo(cwd, manifest, deadline.signal)); }
                    catch (error) { deadline.signal.throwIfAborted(); errors.push({ path: manifest, error: inspectionError(error) }); }
                }
                const configurationFiles = scan.files.filter(p => /^(?:tsconfig.*\.json|(?:bun|vite|vitest|jest|eslint)\.config\..+|pyproject\.toml|Cargo\.toml|go\.mod|Dockerfile)$/.test(basename(p)));
                const lockfiles = scan.files.filter(p => /^(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|uv\.lock)$/.test(basename(p)));
                const testFiles = scan.files.filter(isTestFile);
                return limitInspectionOutput({ packages, errors, configurationFiles: configurationFiles.slice(0, 50),
                    lockfiles: lockfiles.slice(0, 30), testFiles: testFiles.slice(0, 50), files: scan.files.slice(0, 100),
                    truncated: scan.truncated || manifests.length > 20 || scan.files.length > 100 || configurationFiles.length > 50
                        || lockfiles.length > 30 || testFiles.length > 50 || packages.some(p => p.truncated) });
            } finally { deadline.dispose(); }
        },
    });
}
