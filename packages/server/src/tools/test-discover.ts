import { tool } from "ai";
import { z } from "zod";
import { basename } from "node:path";
import { projectFiles, packageInfo, isTestFile, inspectionError, limitInspectionOutput } from "../lib/project-inspection";
import { toolDeadline } from "../lib/tool-io";
export function createTestDiscoverTool(cwd: string) {
    return tool({
        description: "Descobre até 100 arquivos de teste por convenção (JS/TS, Python, Go), nomes de scripts e indícios de runners. Inspeção estática, até 20 manifests/2 mil entradas/15 segundos; não enumera casos gerados em runtime nem executa scripts.",
        inputSchema: z.object({ path: z.string().max(1_000).optional() }),
        execute: async ({ path }, { abortSignal }) => {
            const deadline = toolDeadline(abortSignal);
            try {
                const scan = await projectFiles(cwd, path ?? ".", deadline.signal);
                const manifests = scan.files.filter(p => basename(p) === "package.json"), packages = [], errors = [];
                for (const manifest of manifests.slice(0, 20)) {
                    try {
                        const pkg = await packageInfo(cwd, manifest, deadline.signal);
                        packages.push({ path: pkg.path, scripts: pkg.scripts.filter(s => /^test(?::|$)/.test(s)), runners: pkg.dependencies.filter(d => ["vitest", "jest", "@jest/core", "bun-types"].includes(d)), truncated: pkg.truncated });
                    } catch (error) { deadline.signal.throwIfAborted(); errors.push({ path: manifest, error: inspectionError(error) }); }
                }
                const tests = scan.files.filter(isTestFile);
                const configurationFiles = scan.files.filter(p => /(?:^|\/)(?:(?:vitest|jest)\.config\.[^/]+|pytest\.ini|pyproject\.toml|bun\.lockb?|go\.mod)$/.test(p));
                return limitInspectionOutput({ tests: tests.slice(0, 100), packages, errors,
                    configurationFiles: configurationFiles.slice(0, 30),
                    discovery: "static-conventions", truncated: scan.truncated || tests.length > 100 || manifests.length > 20 || configurationFiles.length > 30 || packages.some(p => p.truncated) });
            } finally { deadline.dispose(); }
        },
    });
}
