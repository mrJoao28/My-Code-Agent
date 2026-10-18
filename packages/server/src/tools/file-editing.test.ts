import { expect, test } from "bun:test";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, withFixture } from "../test-support";
import { createEditFileTool } from "./edit-file";
import { createWriteFileTool } from "./write-file";
import { createReadFileTool } from "./read-file";

for (const mode of [0o755, 0o750, 0o640]) {
    test(`edit and overwrite preserve existing mode ${mode.toString(8)}`, withFixture(async ({ cwd }) => {
        const path = join(cwd, "script");
        await writeFile(path, "old"); await chmod(path, mode);
        // Windows não representa os bits POSIX de execução/grupo separadamente.
        const originalMode = (await stat(path)).mode & 0o777;
        if (process.platform !== "win32") expect(originalMode).toBe(mode);
        await execute(createEditFileTool(cwd), { path: "script", old_str: "old", new_str: "edited" });
        expect((await stat(path)).mode & 0o777).toBe(originalMode);
        await execute(createWriteFileTool(cwd), { path: "script", content: "written", backup: true });
        expect((await stat(path)).mode & 0o777).toBe(originalMode);
        expect(await readFile(path, "utf8")).toBe("written");
        expect(await readFile(path + ".bak", "utf8")).toBe("edited");
    }));
}

test("new files use mode 0644 on POSIX and remain writable on Windows", withFixture(async ({ cwd }) => {
    for (const overwrite of [true, false]) {
        const path = `${overwrite}.txt`;
        await execute(createWriteFileTool(cwd), { path, content: "new", overwrite });
        const mode = (await stat(join(cwd, path))).mode & 0o777;
        if (process.platform !== "win32") expect(mode).toBe(0o644);
        else expect(mode & 0o200).toBe(0o200);
    }
}));

test.skipIf(process.platform === "win32")("replacement retains mode even with a restrictive umask", withFixture(async ({ cwd }) => {
    const path = join(cwd, "script");
    await writeFile(path, "old"); await chmod(path, 0o755);
    const previous = process.umask(0o077);
    try {
        await execute(createEditFileTool(cwd), { path: "script", old_str: "old", new_str: "edited" });
        expect((await stat(path)).mode & 0o777).toBe(0o755);
        await execute(createWriteFileTool(cwd), { path: "script", content: "written" });
        expect((await stat(path)).mode & 0o777).toBe(0o755);
    } finally { process.umask(previous); }
}));

for (const eol of ["\n", "\r\n"]) {
    test(`multiline edit accepts either input EOL and preserves ${JSON.stringify(eol)}`, withFixture(async ({ cwd }) => {
        const path = join(cwd, "a.txt");
        const original = ["head", "alpha []", "beta $&", "tail", ""].join(eol);
        for (const inputEol of ["\n", "\r\n"]) {
            await writeFile(path, original);
            await execute(createEditFileTool(cwd), {
                path: "a.txt", old_str: ["alpha []", "beta $&"].join(inputEol),
                new_str: ["changed", "again $&"].join(inputEol),
            });
            expect(await readFile(path, "utf8")).toBe(["head", "changed", "again $&", "tail", ""].join(eol));
        }
    }));
}

test("mixed EOL uses the dominant ending for replacements without changing other bytes", withFixture(async ({ cwd }) => {
    const path = join(cwd, "a");
    await writeFile(path, "head\r\nkeep\nold\r\ntail\r\n");
    await execute(createEditFileTool(cwd), { path: "a", old_str: "old", new_str: "new\nline" });
    expect(await readFile(path, "utf8")).toBe("head\r\nkeep\nnew\r\nline\r\ntail\r\n");
}));

test("EOL ties use the first ending and files without newlines default to LF", withFixture(async ({ cwd }) => {
    const path = join(cwd, "a");
    await writeFile(path, "head\r\nold\ntail");
    await execute(createEditFileTool(cwd), { path: "a", old_str: "old", new_str: "new\nline" });
    expect(await readFile(path, "utf8")).toBe("head\r\nnew\r\nline\ntail");
    await writeFile(path, "old");
    await execute(createEditFileTool(cwd), { path: "a", old_str: "old", new_str: "new\r\nline" });
    expect(await readFile(path, "utf8")).toBe("new\nline");
}));

test("empty reads contain no invented numbered line", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "empty"), "");
    const result = await execute(createReadFileTool(cwd), { path: "empty" });
    expect(result).toMatchObject({ content: "", totalLines: 0, truncated: false });
    expect(result.nextOffset).toBeUndefined();
}));

test("normalized multiline occurrence counts reject zero and ambiguous matches without writing", withFixture(async ({ cwd }) => {
    const path = join(cwd, "a"), original = "a\r\nb\r\n---\na\nb";
    await writeFile(path, original);
    for (const [old_str, count] of [["a\nb", 2], ["missing\ntext", 0]] as const) {
        await expect(execute(createEditFileTool(cwd), { path: "a", old_str, new_str: "bad" })).rejects.toThrow(`${count} ocorrências`);
        expect(await readFile(path, "utf8")).toBe(original);
    }
}));

test("read numbers absolute lines by default and provides a continuation for limit", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "a"), "one\r\ntwo\r\nthree");
    const page = await execute(createReadFileTool(cwd), { path: "a", offset: 1, limit: 1 });
    expect(page).toMatchObject({ content: "2: two", totalLines: 3, nextOffset: 2, truncated: true });
    expect(page.continuation).toContain("offset=2"); expect(page.continuation).toContain("limit=1");
    const last = await execute(createReadFileTool(cwd), { path: "a", offset: page.nextOffset, limit: 1, numbered: false });
    expect(last).toMatchObject({ content: "three", truncated: false });
    expect(last.nextOffset).toBeUndefined();
    expect((await execute(createReadFileTool(cwd), { path: "a", offset: 99 })).content).toBe("");
}));

test("read paginates complete Unicode lines without dropping, duplicating or appending tail content", withFixture(async ({ cwd }) => {
    const lines = Array.from({ length: 12 }, (_, i) => `${i}: ${"漢😀".repeat(400)}`);
    await writeFile(join(cwd, "a"), lines.join("\r\n"));
    const received: string[] = [];
    let offset = 0;
    for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
        const page = await execute(createReadFileTool(cwd), { path: "a", offset, numbered: false });
        expect(page.content.length).toBeLessThanOrEqual(10_000);
        received.push(...page.content.split("\n"));
        if (page.nextOffset === undefined) { expect(page.truncated).toBe(false); break; }
        expect(page.nextOffset).toBeGreaterThan(offset);
        expect(page.truncated).toBe(true);
        offset = page.nextOffset;
    }
    expect(received).toEqual(lines);
}));

test("read stops at the end and makes an oversized single line explicit", withFixture(async ({ cwd }) => {
    await writeFile(join(cwd, "a"), "x".repeat(9_000) + "\n" + "tail".repeat(1_000));
    const page = await execute(createReadFileTool(cwd), { path: "a" });
    expect(page.content).toBe("1: " + "x".repeat(9_000));
    expect(page.nextOffset).toBe(1);
    expect((await execute(createReadFileTool(cwd), { path: "a", offset: 1 })).content).toBe("2: " + "tail".repeat(1_000));
    await writeFile(join(cwd, "long"), "x".repeat(10_001));
    await expect(execute(createReadFileTool(cwd), { path: "long" })).rejects.toThrow("LINE_TOO_LONG");
}));
