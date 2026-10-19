import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFixture } from "../../server/src/test-support";

const node = Bun.which("node");
if (!node) throw new Error("Os testes do launcher npm precisam de Node.js no PATH.");
const envWithoutPath = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));

async function prepare(cwd: string) {
    const bin = join(cwd, "bin");
    await mkdir(bin); await mkdir(join(cwd, "dist"));
    await copyFile(new URL("../bin/myagent.js", import.meta.url), join(bin, "myagent.js"));
    await writeFile(join(cwd, "package.json"), '{"type":"module"}');
    return bin;
}

test("Node launcher explains how to install Bun when PATH has no runtime", withFixture(async ({ cwd }) => {
    const bin = await prepare(cwd);
    const child = Bun.spawn([node!, join(bin, "myagent.js"), "--version"], {
        cwd, env: { ...envWithoutPath, PATH: bin }, stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const error = await new Response(child.stderr).text();
    expect(error).toContain("https://bun.sh"); expect(error).toContain("PATH");
    expect(error).not.toContain("Error:");
}), 15_000);

test("Node launcher inherits output, cwd and arguments and returns the Bun exit code", withFixture(async ({ cwd }) => {
    const bin = await prepare(cwd);
    const fakeBun = join(bin, process.platform === "win32" ? "bun.exe" : "bun");
    await copyFile(node!, fakeBun); await chmod(fakeBun, 0o755);
    await writeFile(join(cwd, "dist/cli.js"), `import {readFileSync} from "node:fs";console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:readFileSync(0,"utf8")}));console.error("stderr herdado");process.exitCode=23;`);
    const child = Bun.spawn([node!, join(bin, "myagent.js"), "argumento com espaços", "literal;&$"], {
        cwd, env: { ...envWithoutPath, PATH: bin }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write("entrada herdada");
    await child.stdin.end();
    expect(await child.exited).toBe(23);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ args: ["argumento com espaços", "literal;&$"], cwd, input: "entrada herdada" });
    expect(await new Response(child.stderr).text()).toContain("stderr herdado");
}), 15_000);

test("npm entry point has a Node shebang and is explicitly included in the package", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.bin.myagent).toBe("bin/myagent.js");
    expect(manifest.files).toContain("bin/myagent.js");
    expect((await readFile(new URL("../bin/myagent.js", import.meta.url), "utf8")).split("\n")[0]).toBe("#!/usr/bin/env node");
});
