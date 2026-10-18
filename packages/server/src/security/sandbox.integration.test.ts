import { test, expect } from "bun:test";
import { writeFile, readFile, mkdir, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { runSandboxCommand, setDockerAvailable, isDockerAvailable } from "./sandbox";
import { withFixture } from "../test-support";
import { createTestRunTool } from "../tools/test-run";
import { secureTools } from "./tool-policy";
import { execute } from "../test-support";

const image = process.env.MYAGENT_TEST_DOCKER_IMAGE;
const bunImage = process.env.MYAGENT_TEST_BUN_DOCKER_IMAGE;

test.skipIf(!bunImage)("real Docker: Bun tests use installed dependencies read-only without approval or network", withFixture(async ({ cwd }) => {
    const previousImage = process.env.MYAGENT_SANDBOX_IMAGE;
    const previousDependencies = process.env.MYAGENT_SANDBOX_DEPENDENCIES;
    const available = isDockerAvailable(); setDockerAvailable(true);
    process.env.MYAGENT_SANDBOX_IMAGE = bunImage!;
    process.env.MYAGENT_SANDBOX_DEPENDENCIES = "1";
    try {
        await mkdir(join(cwd, "node_modules/fixture-dep/dist"), { recursive: true });
        await mkdir(join(cwd, "node_modules/.bin"), { recursive: true });
        await writeFile(join(cwd, "package.json"), '{"type":"module"}');
        await writeFile(join(cwd, "node_modules/fixture-dep/package.json"), '{"type":"module","exports":"./dist/index.js"}');
        await writeFile(join(cwd, "node_modules/fixture-dep/dist/index.js"), "export default 42;");
        await writeFile(join(cwd, "node_modules/fixture-dep/dist/cli.js"), "#!/usr/bin/env bun\nimport answer from './index.js'; console.log(answer);");
        await chmod(join(cwd, "node_modules/fixture-dep/dist/cli.js"), 0o755);
        if (process.platform !== "win32") await symlink("../fixture-dep/dist/cli.js", join(cwd, "node_modules/.bin/fixture-cli"));
        await writeFile(join(cwd, "fixture.test.ts"), `import { test, expect } from 'bun:test';
import answer from 'fixture-dep';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
test('installed dependency, read-only source and dependency, offline network', () => {
 expect(answer).toBe(42);
 expect(() => writeFileSync('/workspace/unwanted', '')).toThrow();
 expect(() => writeFileSync('node_modules/fixture-dep/dist/index.js', '')).toThrow();
 writeFileSync('only-temporary.txt', 'ok');
 expect(existsSync('only-temporary.txt')).toBe(true);
 const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\\n');
 expect(routes.length).toBe(1);
 ${process.platform !== "win32" ? "expect(Bun.spawnSync(['fixture-cli']).stdout.toString().trim()).toBe('42');" : ""}
});`);
        let approvals = 0;
        const tools = secureTools({ test_run: createTestRunTool(cwd) }, cwd, "PLAN", "fixture", {
            sandboxAvailable: true, authorize: async () => cwd, notify: async () => { approvals++; throw new Error("unexpected approval"); },
        });
        const result = await execute(tools.test_run, { runner: "bun" });
        expect(result.stderr + result.stdout).toContain("1 pass");
        expect(result.status).toBe("passed"); expect(approvals).toBe(0);
        expect(await Bun.file(join(cwd, "only-temporary.txt")).exists()).toBe(false);
        expect(await readFile(join(cwd, "node_modules/fixture-dep/dist/index.js"), "utf8")).toBe("export default 42;");
    } finally {
        setDockerAvailable(available);
        if (previousImage === undefined) delete process.env.MYAGENT_SANDBOX_IMAGE; else process.env.MYAGENT_SANDBOX_IMAGE = previousImage;
        if (previousDependencies === undefined) delete process.env.MYAGENT_SANDBOX_DEPENDENCIES; else process.env.MYAGENT_SANDBOX_DEPENDENCIES = previousDependencies;
    }
}), 60_000);
test.skipIf(!image)("real Docker: secrets, host environment, writes and network are isolated", withFixture(async ({ cwd }) => {
    const previousImage = process.env.MYAGENT_SANDBOX_IMAGE;
    const available = isDockerAvailable(); setDockerAvailable(true);
    const previousProbe = process.env.MYAGENT_LEAK_PROBE;
    process.env.MYAGENT_SANDBOX_IMAGE = image!;
    process.env.MYAGENT_LEAK_PROBE = "fixture-secret";
    try {
        await writeFile(join(cwd, "public.txt"), "visible");
        await writeFile(join(cwd, ".env"), "fixture-secret");
        await mkdir(join(cwd, ".aws"));
        await mkdir(join(cwd, "custom-config"));
        await writeFile(join(cwd, "custom-config/api-token"), "fixture-secret");
        const command = [
            'test "$(id -u)" = "65534"',
            'test -z "$MYAGENT_LEAK_PROBE"',
            'test ! -e /workspace/.env',
            'test ! -e /workspace/.aws',
            'test ! -e /workspace/custom-config/api-token',
            'test "$(cat /workspace/public.txt)" = "visible"',
            'test -z "$(ip route)"',
            'grep -q "CapEff:.*0000000000000000" /proc/self/status',
            'if touch /workspace/created 2>/dev/null; then exit 1; fi',
            'echo temporary >/tmp/output',
            'echo isolated',
        ].join(" && ");
        const result = await runSandboxCommand(cwd, command, 20_000);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("isolated");
        expect(await readFile(join(cwd, ".env"), "utf8")).toBe("fixture-secret");
    } finally {
        setDockerAvailable(available);
        if (previousImage === undefined) delete process.env.MYAGENT_SANDBOX_IMAGE; else process.env.MYAGENT_SANDBOX_IMAGE = previousImage;
        if (previousProbe === undefined) delete process.env.MYAGENT_LEAK_PROBE; else process.env.MYAGENT_LEAK_PROBE = previousProbe;
    }
}), 30_000);
test.skipIf(!image)("real Docker: timed out container is stopped", withFixture(async ({ cwd }) => {
    const previous = process.env.MYAGENT_SANDBOX_IMAGE;
    const available = isDockerAvailable(); setDockerAvailable(true);
    process.env.MYAGENT_SANDBOX_IMAGE = image!;
    try {
        const result = await runSandboxCommand(cwd, "sleep 30", 1000);
        expect(result.timedOut).toBe(true); expect(result.exitCode).toBe(124);
    } finally { setDockerAvailable(available); if (previous === undefined) delete process.env.MYAGENT_SANDBOX_IMAGE; else process.env.MYAGENT_SANDBOX_IMAGE = previous; }
}), 20_000);
