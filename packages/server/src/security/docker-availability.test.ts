import { expect, mock, test } from "bun:test";
import { createTools } from "../tools";
import { checkDocker, ensureSandboxImage, type CommandResult } from "./sandbox";
import { buildSystemPrompt } from "../prompts";

const result = (exitCode: number, timedOut = false): CommandResult => ({ exitCode, timedOut, stdout: "", stderr: "", truncated: false });
test.each(["PLAN", "BUILD"] as const)("%s exposes process tools only when Docker is available", mode => {
    const disabled = createTools("/fixture", mode, "s", { sandboxAvailable: false });
    expect(disabled).not.toHaveProperty("bash");
    expect(disabled).not.toHaveProperty("type_check");
    expect(disabled).not.toHaveProperty("test_run");
    const enabled = createTools("/fixture", mode, "s", { sandboxAvailable: true });
    expect(enabled).toHaveProperty("type_check");
    expect(enabled).toHaveProperty("test_run");
    if (mode === "BUILD") expect(enabled).toHaveProperty("bash");
    else for (const name of ["bash", "write_file", "edit_file", "delete_file", "move_file", "apply_patch", "git_commit"]) expect(enabled).not.toHaveProperty(name);
    expect(buildSystemPrompt({ cwd: "/fixture", mode, sandboxConfigured: false })).toContain("não há execução de comandos");
});

test("Docker detection is bounded, fails closed and respects cancellation", async () => {
    expect(await checkDocker(undefined, async () => result(0))).toBe(true);
    expect(await checkDocker(undefined, async () => result(124, true))).toBe(false);
    expect(await checkDocker(undefined, async () => { throw new Error("not found"); })).toBe(false);
    const controller = new AbortController(); controller.abort();
    await expect(checkDocker(controller.signal, async () => result(0))).rejects.toThrow();
});

test("sandbox image pulls only on demand and explains network failures", async () => {
    const run = mock(async (_command: string, args: string[]) => result(args[0] === "image" ? 1 : 0));
    const messages: string[] = [];
    await ensureSandboxImage("fixture:1", undefined, run, message => { messages.push(message); return true; });
    expect(run.mock.calls.map(call => call[1][0])).toEqual(["image", "pull"]);
    expect(messages.join("")).toContain("baixando");
    await expect(ensureSandboxImage("fixture:1", undefined, async () => result(1), () => true)).rejects.toThrow("conexão de rede");
    const present = mock(async () => result(0));
    await ensureSandboxImage("fixture:1", undefined, present);
    expect(present).toHaveBeenCalledTimes(1);
});
