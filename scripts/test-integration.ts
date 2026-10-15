const image = process.env.MYAGENT_TEST_DOCKER_IMAGE ?? process.env.MYAGENT_SANDBOX_IMAGE;
if (!image) throw new Error("Configure MYAGENT_TEST_DOCKER_IMAGE com uma imagem Docker Linux local que tenha /bin/sh.");
const result = Bun.spawnSync([process.execPath, "test", "packages/server/src/security/sandbox.integration.test.ts"], {
    env: { ...process.env, MYAGENT_TEST_DOCKER_IMAGE: image },
    stdout: "inherit", stderr: "inherit",
});
process.exit(result.exitCode);
