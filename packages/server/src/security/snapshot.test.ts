import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, rm, symlink, utimes, writeFile, link } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotCache, snapshotWorkspace, snapshotOptions, boundedSetting } from "./snapshot";
import { dockerArguments } from "./sandbox";
import { withFixture } from "../test-support";

async function dependencies<T>(run: () => Promise<T>) {
    const previous = process.env.MYAGENT_SANDBOX_DEPENDENCIES;
    process.env.MYAGENT_SANDBOX_DEPENDENCIES = "1";
    try { return await run(); }
    finally { if (previous === undefined) delete process.env.MYAGENT_SANDBOX_DEPENDENCIES; else process.env.MYAGENT_SANDBOX_DEPENDENCIES = previous; }
}

test("opt-in dependencies retain dist and .venv but omit credentials, external links and hard links", withFixture(async ({ cwd, outside, root }) => {
    await mkdir(join(cwd, "node_modules/pkg/dist"), { recursive: true });
    await writeFile(join(cwd, "node_modules/pkg/dist/index.js"), "export default 42;");
    await writeFile(join(cwd, "node_modules/pkg/.env"), "fixture");
    await mkdir(join(cwd, ".venv/lib"), { recursive: true });
    await writeFile(join(cwd, ".venv/lib/module.py"), "answer=42");
    await symlink(outside, join(cwd, "node_modules/external"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(cwd, "node_modules/pkg/hard.js"), "fixture");
    await link(join(cwd, "node_modules/pkg/hard.js"), join(cwd, "node_modules/pkg/alias.js"));
    await dependencies(async () => {
        // Hard links fail closed rather than exposing an alias to protected data.
        await expect(snapshotWorkspace(cwd, join(root, "blocked"))).rejects.toThrow();
        await rm(join(cwd, "node_modules/pkg/alias.js"));
        await rm(join(cwd, "node_modules/pkg/hard.js"));
        const dest = join(root, "safe"); await snapshotWorkspace(cwd, dest);
        expect(await readFile(join(dest, "node_modules/pkg/dist/index.js"), "utf8")).toContain("42");
        expect(await readFile(join(dest, ".venv/lib/module.py"), "utf8")).toBe("answer=42");
        expect(await readdir(join(dest, "node_modules"))).toEqual(["pkg"]);
        expect(await readdir(join(dest, "node_modules/pkg"))).toEqual(["dist"]);
    });
}));

test("dependency byte limits and invalid flags fail closed", withFixture(async ({ cwd, root }) => {
    const previous = process.env.MYAGENT_SANDBOX_DEPENDENCY_MIB;
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "node_modules/large.js"), Buffer.alloc(1024 * 1024 + 1));
    try {
        process.env.MYAGENT_SANDBOX_DEPENDENCY_MIB = "1";
        await dependencies(async () => { await expect(snapshotWorkspace(cwd, join(root, "snapshot"))).rejects.toThrow("limites de tamanho"); });
    } finally { if (previous === undefined) delete process.env.MYAGENT_SANDBOX_DEPENDENCY_MIB; else process.env.MYAGENT_SANDBOX_DEPENDENCY_MIB = previous; }
    const flag = process.env.MYAGENT_SANDBOX_DEPENDENCIES;
    try { process.env.MYAGENT_SANDBOX_DEPENDENCIES = "yes"; expect(snapshotOptions).toThrow("0 ou 1"); }
    finally { if (flag === undefined) delete process.env.MYAGENT_SANDBOX_DEPENDENCIES; else process.env.MYAGENT_SANDBOX_DEPENDENCIES = flag; }
}));

test.skipIf(process.platform === "win32")(".bin links become shims preserving relative imports; external and chained links are omitted", withFixture(async ({ cwd, outside, root }) => {
    await mkdir(join(cwd, "node_modules/.bin"), { recursive: true });
    await mkdir(join(cwd, "node_modules/pkg/dist"), { recursive: true });
    await writeFile(join(cwd, "node_modules/pkg/dist/cli.js"), "#!/usr/bin/env bun\nimport './other.js';");
    await writeFile(join(cwd, "node_modules/pkg/dist/other.js"), "export {};");
    await writeFile(join(outside, "external.js"), "fixture");
    await symlink("../pkg/dist/cli.js", join(cwd, "node_modules/.bin/local"));
    await symlink(join(outside, "external.js"), join(cwd, "node_modules/.bin/external"));
    await symlink("local", join(cwd, "node_modules/.bin/chained"));
    await dependencies(async () => {
        const dest = join(root, "snapshot"); await snapshotWorkspace(cwd, dest);
        expect(await readdir(join(dest, "node_modules/.bin"))).toEqual(["local"]);
        expect((await lstat(join(dest, "node_modules/.bin/local"))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(dest, "node_modules/.bin/local"), "utf8")).toBe("#!/bin/sh\nexec '/workspace/node_modules/pkg/dist/cli.js' \"$@\"\n");
        expect((await lstat(join(dest, "node_modules/pkg/dist/cli.js"))).mode & 0o111).not.toBe(0);
    });
}));

test("session snapshots reuse bytes and invalidate on modification, size, addition, deletion and dependency flag", withFixture(async ({ cwd }) => {
    const cache = new SnapshotCache();
    const file = join(cwd, "a.ts"); await writeFile(file, "first");
    try {
        const first = await cache.acquire(cwd, "s"); const original = first.directory; first.release();
        const same = await cache.acquire(cwd, "s"); expect(same.directory).toBe(original); same.release();
        const old = await lstat(file); await writeFile(file, "other"); await utimes(file, old.atime, new Date(old.mtimeMs + 2000));
        const changed = await cache.acquire(cwd, "s"); expect(changed.directory).not.toBe(original); expect(await readFile(join(changed.directory, "a.ts"), "utf8")).toBe("other"); changed.release();
        let last = changed.directory;
        for (const mutate of [async () => writeFile(file, "longer file"), async () => writeFile(join(cwd, "b.ts"), "b"), async () => rm(join(cwd, "b.ts"))]) {
            await mutate(); const next = await cache.acquire(cwd, "s"); expect(next.directory).not.toBe(last); last = next.directory; next.release();
        }
        await dependencies(async () => { const next = await cache.acquire(cwd, "s"); expect(next.directory).not.toBe(last); next.release(); });
        const other = await cache.acquire(cwd, "other"); expect(other.directory).not.toBe(last); other.release();
    } finally { await cache.dispose(); }
}));

test("leases serialize same-session commands, expire and honor cancellation", withFixture(async ({ cwd }) => {
    const cache = new SnapshotCache(30);
    try {
        const first = await cache.acquire(cwd, "s"); let acquired = false;
        const cancelled = new AbortController();
        const waiting = cache.acquire(cwd, "s", cancelled.signal);
        cancelled.abort(new Error("cancelled while queued"));
        await expect(waiting).rejects.toThrow("cancelled while queued");
        const pending = cache.acquire(cwd, "s").then(lease => { acquired = true; return lease; });
        await Bun.sleep(5); expect(acquired).toBe(false); first.release();
        const second = await pending; expect(second.directory).toBe(first.directory); second.release(); second.release();
        await Bun.sleep(100);
        const next = await cache.acquire(cwd, "s"); expect(next.directory).not.toBe(first.directory); next.release();
        const controller = new AbortController(); controller.abort();
        await expect(cache.acquire(cwd, "s", controller.signal)).rejects.toThrow();
    } finally { await cache.dispose(); }
}));

test("tmpfs size is bounded configuration and isolation flags stay intact", () => {
    const previous = process.env.MYAGENT_SANDBOX_TMPFS_MIB;
    try {
        process.env.MYAGENT_SANDBOX_TMPFS_MIB = "256";
        expect(dockerArguments("/safe", "test", "bun", "bun test")).toContain("/tmp:rw,nosuid,nodev,size=256m,mode=1777");
        for (const invalid of ["0", "4097", "64m", "64,exec", "-1"]) {
            process.env.MYAGENT_SANDBOX_TMPFS_MIB = invalid;
            expect(() => boundedSetting("MYAGENT_SANDBOX_TMPFS_MIB", 64, 4096)).toThrow();
        }
    } finally { if (previous === undefined) delete process.env.MYAGENT_SANDBOX_TMPFS_MIB; else process.env.MYAGENT_SANDBOX_TMPFS_MIB = previous; }
});
