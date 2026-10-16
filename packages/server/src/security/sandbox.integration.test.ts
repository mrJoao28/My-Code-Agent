import { test, expect } from "bun:test";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runSandboxCommand, setDockerAvailable, isDockerAvailable } from "./sandbox";
import { withFixture } from "../test-support";

const image = process.env.MYAGENT_TEST_DOCKER_IMAGE;
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
