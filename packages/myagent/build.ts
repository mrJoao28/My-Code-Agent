import { mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";

const directory = import.meta.dirname;
const outdir = resolve(directory, "dist");
await mkdir(outdir, { recursive: true });
const external = ["@libsql/client", "@prisma/adapter-libsql", "@prisma/client", "@opentui/core", "@opentui/react", "react"];
const result = await Bun.build({
    entrypoints: [resolve(directory, "src/cli.ts"), resolve(directory, "../server/src/lib/source-worker.ts"), resolve(directory, "../server/src/lib/grep-worker.ts")],
    outdir, naming: "[name].js", target: "bun", format: "esm", splitting: false,
    external, define: { MYAGENT_BUNDLED: "true", "process.env.NODE_ENV": JSON.stringify("production") },
    tsconfig: resolve(directory, "../cui/tsconfig.json"),
});
if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
} else {
    await chmod(resolve(outdir, "cli.js"), 0o755);
    console.log(`Bundle Bun criado em ${outdir} (${result.outputs.length} arquivos).`);
}
