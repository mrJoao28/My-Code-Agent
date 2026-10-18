import { expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFixture } from "../../server/src/test-support";
import { detectedTools, missingImageTools } from "./doctor-tools";
import type { CommandResult } from "../../server/src/security/sandbox";

test("doctor detects Bun, TypeScript, test CLIs and other project runtimes without running scripts", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ packageManager: "bun@1.3.13", devDependencies: { typescript: "*", vitest: "*" }, scripts: { test: "never execute this" } }));
    await writeFile(join(cwd, "bun.lock"), ""); await writeFile(join(cwd, "pyproject.toml"), "");
    await writeFile(join(cwd, "pytest.ini"), ""); await writeFile(join(cwd, "go.mod"), "");
    await writeFile(join(cwd, "Cargo.toml"), ""); await mkdir(join(cwd, ".venv"));
    expect(await detectedTools(cwd)).toEqual(["bun", "cargo", "go", "pytest", "python3", "tsc", "vitest"]);
}));
test("doctor checks the local image offline and reports missing commands", async () => {
    const result: CommandResult = { stdout: "tsc\n", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    const run = mock(async (_exe: string, _args: string[], _options: { timeoutMs: number }) => result);
    expect(await missingImageTools("trusted", ["bun", "tsc"], run)).toEqual(["tsc"]);
    const [exe, args] = run.mock.calls[0]!;
    expect(exe).toBe("docker"); expect(args).toContain("--network=none"); expect(args).toContain("--read-only"); expect(args).toContain("--pull=never");
    expect(args.at(-1)).toContain("command -v bun");
    await expect(missingImageTools("trusted", ["bun; unsafe"], run)).rejects.toThrow();
    await expect(missingImageTools("trusted", ["bun"], async () => ({ ...result, timedOut: true }))).rejects.toThrow("não respondeu");
});
