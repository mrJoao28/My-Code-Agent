import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { CheckpointStore, CHECKPOINT_FILE_BYTES } from "./checkpoints";
import { ApprovalManager } from "./permissions";
import { createTools } from "../tools";
import { runProcess } from "./sandbox";
import { runGit } from "../utils/git";
import { execute, withFixture, type Fixture } from "../test-support";

function setup({ cwd, root }: Fixture) {
    const store = new CheckpointStore(join(root, "checkpoints"));
    const manager = new ApprovalManager();
    const tools = createTools(cwd, "BUILD", "session", { checkpoints: store, manager, authorize: async () => cwd,
        notify: async event => { manager.decide("session", event.approvalId, true); } }) as ToolSet;
    return { store, run: (name: string, args: object) => execute(tools[name]!, args) };
}

test("edit preview approval saves an exact CRLF pre-image and preserves mode through undo after reload", withFixture(async fixture => {
    const { cwd, root } = fixture, { run } = setup(fixture);
    const path = join(cwd, "a.ts"); await writeFile(path, "one\r\ntwo\r\n"); await chmod(path, 0o755);
    const previousMode = (await lstat(path)).mode & 0o777;
    const result = await run("edit_file", { path: "a.ts", old_str: "one\ntwo", new_str: "three\nfour" }) as { checkpoint: { id: string }; approval: object };
    expect(result.checkpoint.id).toBeTruthy(); expect(result.approval).toMatchObject({ choice: "once" });
    expect(await readFile(path, "utf8")).toBe("three\r\nfour\r\n");
    const restored = await new CheckpointStore(join(root, "checkpoints")).undo(cwd, "session");
    expect(restored.paths).toEqual(["a.ts"]);
    expect(await readFile(path, "utf8")).toBe("one\r\ntwo\r\n");
    expect((await lstat(path)).mode & 0o777).toBe(previousMode);
}));

test("write with backup, multiple undo steps and new parent directories restore their prior state", withFixture(async fixture => {
    const { cwd } = fixture, { store, run } = setup(fixture);
    await writeFile(join(cwd, "a"), "original");
    await run("write_file", { path: "a", content: "second", backup: true });
    await run("edit_file", { path: "a", old_str: "second", new_str: "third" });
    await store.undo(cwd, "session"); expect(await readFile(join(cwd, "a"), "utf8")).toBe("second");
    await store.undo(cwd, "session"); expect(await readFile(join(cwd, "a"), "utf8")).toBe("original");
    expect(await Bun.file(join(cwd, "a.bak")).exists()).toBe(false);
    await run("write_file", { path: "new/deep/file.ts", content: "new" });
    await store.undo(cwd, "session"); expect(await readdir(cwd)).toEqual(["a"]);
}));

test("rewriting identical bytes remains an undo step instead of invalidating the previous step", withFixture(async fixture => {
    const { cwd } = fixture, { store, run } = setup(fixture);
    await writeFile(join(cwd, "a"), "original");
    await run("write_file", { path: "a", content: "updated" });
    await Bun.sleep(20);
    await run("write_file", { path: "a", content: "updated" });
    await store.undo(cwd, "session");
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("updated");
    await store.undo(cwd, "session");
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("original");
}));

test("move and recursive delete restore the whole tree without Git or commits", withFixture(async fixture => {
    const { cwd } = fixture, { store, run } = setup(fixture);
    await mkdir(join(cwd, "source")); await writeFile(join(cwd, "source/a"), "content");
    await run("move_file", { from: "source", to: "destination" });
    await store.undo(cwd, "session"); expect(await readdir(cwd)).toEqual(["source"]);
    await run("delete_file", { path: "source", recursive: true }); expect(await readdir(cwd)).toEqual([]);
    await store.undo(cwd, "session"); expect(await readFile(join(cwd, "source/a"), "utf8")).toBe("content");
    expect(await Bun.file(join(cwd, ".git")).exists()).toBe(false);
}));

test("undo preflights every path and refuses a changed or recreated file without partial restoration", withFixture(async fixture => {
    const { cwd } = fixture, { store, run } = setup(fixture);
    await writeFile(join(cwd, "a"), "source"); await writeFile(join(cwd, "b"), "destination");
    await run("move_file", { from: "a", to: "b", overwrite: true });
    await writeFile(join(cwd, "a"), "user work");
    await expect(store.undo(cwd, "session")).rejects.toThrow("Conflito");
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("user work");
    expect(await readFile(join(cwd, "b"), "utf8")).toBe("source");
    await expect(store.undo(cwd, "other-session")).rejects.toThrow("Não há passo");
}));

test("limits, links and canceled operations fail before any project write", withFixture(async fixture => {
    const { cwd, outside } = fixture, { store, run } = setup(fixture);
    await writeFile(join(cwd, "large"), Buffer.alloc(CHECKPOINT_FILE_BYTES + 1));
    await expect(run("write_file", { path: "large", content: "small" })).rejects.toThrow("limite");
    expect((await lstat(join(cwd, "large"))).size).toBe(CHECKPOINT_FILE_BYTES + 1);
    await symlink(outside, join(cwd, "external"), process.platform === "win32" ? "junction" : "dir");
    await expect(run("write_file", { path: "external/untouched", content: "no" })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(store.run(cwd, "cancel", "write_file", { path: "never", content: "no" }, async () => writeFile(join(cwd, "never"), "no"), controller.signal)).rejects.toThrow();
    expect(await Bun.file(join(cwd, "never")).exists()).toBe(false);
}));

test("failed writes leave no phantom step; retention removes only inactive session artifacts", withFixture(async fixture => {
    const { cwd, root } = fixture, { store, run } = setup(fixture);
    await writeFile(join(cwd, "a"), "original");
    await expect(run("edit_file", { path: "a", old_str: "missing", new_str: "no" })).rejects.toThrow("0 ocorrências");
    await expect(store.undo(cwd, "session")).rejects.toThrow("Não há passo");
    await run("write_file", { path: "a", content: "modified" });
    await store.run(cwd, "expired", "write_file", { path: "b", content: "b" }, async () => writeFile(join(cwd, "b"), "b"));
    await store.prune(async id => id === "session");
    expect(await readdir(join(root, "checkpoints"))).toEqual(["session"]);
}));

test("multi-file patches form one undo step and preserve pre-existing uncommitted bytes", withFixture(async fixture => {
    const { cwd } = fixture, { store, run } = setup(fixture);
    expect((await runProcess("git", ["init", cwd], { timeoutMs: 10_000 })).exitCode).toBe(0);
    await writeFile(join(cwd, "a"), "one\n"); await writeFile(join(cwd, "b"), "two\n");
    await runGit(cwd, ["add", "--", "a", "b"]);
    const indexBefore = await readFile(join(cwd, ".git/index"));
    const patch = "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-one\n+edited\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-two\n+changed\n";
    await run("apply_patch", { patch });
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("edited\n");
    await store.undo(cwd, "session");
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("one\n");
    expect(await readFile(join(cwd, "b"), "utf8")).toBe("two\n");
    expect(await readFile(join(cwd, ".git/index"))).toEqual(indexBefore);
}));
