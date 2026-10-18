import { test, expect } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { getModelApiKeyEnv } from "./model-registry";
import { upsertEnvValue, loadGlobalConfig } from "./env";
import { withFixture } from "../test-support";
test("provider/model key names are deterministic and local models need no cloud key", () => {
    const pricing = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
    expect(getModelApiKeyEnv({ id: "model/name-1", provider: "anthropic", pricing })).toBe("MYAGENT_ANTHROPIC_MODEL_NAME_1_API_KEY");
    expect(getModelApiKeyEnv({ id: "local", provider: "ollama", pricing })).toBeUndefined();
});

test("global config reloads custom model keys, preserves environment precedence and ignores unrelated settings", withFixture(async ({ root }) => {
    const key = "MYAGENT_FIXTURE_CUSTOM_SECRET", previous = process.env[key];
    const path = join(root, "config.env"), models = join(root, "models.json");
    await writeFile(path, `${key}=fixture-value\nMYAGENT_WORKSPACE_ROOTS=invalid\n`);
    await writeFile(models, JSON.stringify([{ id: "fixture", provider: "openai", apiKeyEnv: key }]));
    const roots = process.env.MYAGENT_WORKSPACE_ROOTS;
    try {
        delete process.env[key];
        loadGlobalConfig(path, models);
        expect(process.env[key]).toBe("fixture-value");
        process.env[key] = "environment-value";
        loadGlobalConfig(path, models);
        expect(process.env[key]).toBe("environment-value");
        expect(process.env.MYAGENT_WORKSPACE_ROOTS).toBe(roots);
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
}));
test("environment upsert preserves comments/other values and safely quotes replacement", withFixture(async ({ root }) => {
    const name = "MYAGENT_TEST_SETTINGS", previous = process.env[name];
    const path = join(root, "settings.env");
    await writeFile(path, "# comment\nOTHER=value\n" + name + "=old\n");
    try {
        const value = 'fixture "quoted"\nsecond line';
        upsertEnvValue(name, value, path);
        const text = await readFile(path, "utf8");
        expect(text).toContain("# comment"); expect(text).toContain("OTHER=value");
        expect(parse(text)[name]).toBe(value);
        upsertEnvValue(name, "new", path);
        expect((await readFile(path, "utf8")).match(new RegExp(name + "=", "g"))).toHaveLength(1);
    } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
}));
