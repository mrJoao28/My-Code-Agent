import { expect, test } from "bun:test";
import { parseOptions } from "./options";

test("launcher routes default, new, resume, doctor, help and version and rejects ambiguous arguments", () => {
    expect(parseOptions([])).toEqual({ command: "open", createNew: false, all: false });
    expect(parseOptions(["--new"]).createNew).toBe(true);
    expect(parseOptions(["resume"])).toEqual({ command: "resume", createNew: false, all: false });
    expect(parseOptions(["resume", "--all"]).all).toBe(true);
    for (const [argument, command] of [["doctor", "doctor"], ["--help", "help"], ["--version", "version"]] as const) expect(parseOptions([argument]).command).toBe(command);
    for (const args of [["--new", "resume"], ["doctor", "--new"], ["unknown"], ["--all"]]) expect(() => parseOptions(args)).toThrow("--help");
});
