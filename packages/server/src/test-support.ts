import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import type { Tool } from "ai";

export type Fixture = { root: string; cwd: string; outside: string };
export function withFixture(fn: (fixture: Fixture) => unknown | Promise<unknown>) {
    return async () => {
        const root = await mkdtemp(join(tmpdir(), "myagent-test-"));
        const fixture = { root, cwd: join(root, "workspace"), outside: join(root, "outside") };
        await mkdir(fixture.cwd); await mkdir(fixture.outside);
        const previousHome = process.env.MYAGENT_HOME;
        process.env.MYAGENT_HOME = join(root, "global");
        try { await fn(fixture); }
        finally {
            if (previousHome === undefined) delete process.env.MYAGENT_HOME; else process.env.MYAGENT_HOME = previousHome;
            if (dirname(root) !== tmpdir() || !basename(root).startsWith("myagent-test-")) throw new Error("Unsafe fixture cleanup");
            await rm(root, { recursive: true, force: true });
        }
    };
}
export async function execute<I, O>(definition: Tool<I, O>, input: I, signal?: AbortSignal): Promise<O> {
    if (!definition.execute) throw new Error("Missing executor");
    return await definition.execute(input, { toolCallId: "test-call", messages: [], context: {}, abortSignal: signal }) as O;
}
