import { expect, test } from "bun:test";
import { chmod, link, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFixture } from "../test-support";
import { readPrivateConfig, writePrivateConfig } from "./private-config";
import { readModelConfig, writeModelConfig } from "./model-config";
import { loadGlobalConfig, upsertEnvValue } from "./env";

test("config and models replace atomically, stay private and leave no partial file on failure", withFixture(async ({ root }) => {
    for (const name of ["config.env", "models.json"]) {
        const path = join(root, name);
        writePrivateConfig(path, "original");
        expect(() => writePrivateConfig(path, "replacement", (temporary, target) => {
            expect(target).toBe(path);
            expect(readPrivateConfig(String(temporary))).toBe("replacement");
            expect(readPrivateConfig(path)).toBe("original");
            throw new Error("fixture rename failed");
        })).toThrow("fixture rename failed");
        expect(await readFile(path, "utf8")).toBe("original");
        expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
        writePrivateConfig(path, "complete");
        expect(await readFile(path, "utf8")).toBe("complete");
        if (process.platform !== "win32") {
            expect((await stat(path)).mode & 0o777).toBe(0o600);
            await chmod(path, 0o644);
            expect(readPrivateConfig(path)).toBe("complete");
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
    }
}));

test("models corruption and schema errors are explicit and never replaced by an empty catalog", withFixture(async ({ root }) => {
    const path = join(root, "models.json"), env = join(root, "config.env");
    await writeFile(env, "MYAGENT_ENABLE_CHATGPT=1");
    for (const invalid of ["{fixture-secret", "{}", '[{"id":"x","provider":"unknown"}]', '[{"id":"x","provider":"ollama","contextWindow":0}]', '[{"id":"x","provider":"openai","apiKeyEnv":"PATH"}]']) {
        await writeFile(path, invalid);
        expect(() => readModelConfig(path)).toThrow("models.json");
        expect(() => loadGlobalConfig(env, path)).toThrow("models.json");
        expect(await readFile(path, "utf8")).toBe(invalid);
    }
    await writeFile(path, "[]");
    writeModelConfig(path, [{ id: "custom", provider: "ollama" }]);
    expect(readModelConfig(path)[0]?.id).toBe("custom");
    const saved = await readFile(path, "utf8");
    expect(() => writeModelConfig(path, [{ id: "bad" }])).toThrow();
    expect(await readFile(path, "utf8")).toBe(saved);
}));

test("hard links are refused and a failed env write never changes process.env", withFixture(async ({ root }) => {
    const path = join(root, "config.env"), alias = join(root, "alias");
    await writeFile(path, "fixture"); await link(path, alias);
    const previous = process.env.MYAGENT_TEST_PRIVATE_CONFIG;
    try {
        expect(() => readPrivateConfig(path)).toThrow("sem links");
        expect(() => upsertEnvValue("MYAGENT_TEST_PRIVATE_CONFIG", "changed", path)).toThrow();
        expect(process.env.MYAGENT_TEST_PRIVATE_CONFIG).toBe(previous);
        expect(await readFile(path, "utf8")).toBe("fixture");
    } finally { if (previous === undefined) delete process.env.MYAGENT_TEST_PRIVATE_CONFIG; else process.env.MYAGENT_TEST_PRIVATE_CONFIG = previous; }
}));
