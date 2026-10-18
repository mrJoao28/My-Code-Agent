import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";

test("lockfile acompanha nomes, versões publicáveis e dependências dos workspaces", async () => {
    const root = resolve(import.meta.dirname, "..");
    const parsed = ts.parseConfigFileTextToJson("bun.lock", await Bun.file(resolve(root, "bun.lock")).text());
    expect(parsed.error).toBeUndefined();
    const lock = parsed.config as {
        workspaces: Record<string, Record<string, unknown>>;
        packages: Record<string, unknown>;
    };

    for (const [path, workspace] of Object.entries(lock.workspaces)) {
        const manifest = await Bun.file(resolve(root, path, "package.json")).json();
        expect(workspace.name).toBe(manifest.name);
        for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            expect(workspace[group] ?? {}).toEqual(manifest[group] ?? {});
        }
        if (manifest.private !== true) {
            expect(workspace.version).toBe(manifest.version);
            expect(workspace.bin).toEqual(manifest.bin);
        }
        if (path) {
            expect(lock.packages[manifest.name]).toEqual([`${manifest.name}@workspace:${path}`]);
        }
    }
});
