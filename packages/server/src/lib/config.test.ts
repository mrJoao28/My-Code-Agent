import { test, expect } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { getModelApiKeyEnv } from "./model-registry";
import { upsertEnvValue } from "./env";
import { withFixture } from "../test-support";
test("provider/model key names are deterministic and local models need no cloud key", () => {
    const pricing = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
    expect(getModelApiKeyEnv({ id: "model/name-1", provider: "anthropic", pricing })).toBe("MYAGENT_ANTHROPIC_MODEL_NAME_1_API_KEY");
    expect(getModelApiKeyEnv({ id: "local", provider: "ollama", pricing })).toBeUndefined();
});
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
