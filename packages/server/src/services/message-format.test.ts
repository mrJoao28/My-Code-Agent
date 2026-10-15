import { test, expect } from "bun:test";
import { buildConversationHistory, getResumableUserMessage, extractFullText, serializeParts } from "./message-format";
import { buildSystemPrompt } from "../prompts";
import { parseTscOutput } from "../tools/type-check";
test("history maps roles and omits errors and empty assistants", () => {
    expect(buildConversationHistory([
        { role: "USER", content: "question", status: "COMPLETE" },
        { role: "ERROR", content: "failure", status: "COMPLETE" },
        { role: "ASSISTANT", content: "", status: "INTERRUPTED" },
        { role: "ASSISTANT", content: "answer", status: "COMPLETE" },
    ])).toEqual([{ role: "user", content: "question" }, { role: "assistant", content: "answer" }]);
});
test("initial pending user can resume; completed conversation cannot auto replay", () => {
    const user = { role: "USER" as const, model: "test", mode: "PLAN" as const };
    expect(getResumableUserMessage([user])).toEqual(user);
    expect(getResumableUserMessage([])).toBeNull();
    expect(getResumableUserMessage([user, { ...user, role: "ASSISTANT" }])).toBeNull();
});
test("parts extraction preserves only text and validates JSON", () => {
    const parts = [{ type: "text" as const, text: "hello" }, { type: "reasoning" as const, text: "summary" }, { type: "text" as const, text: " world" }];
    expect(extractFullText(parts)).toBe("hello world");
    expect(serializeParts(parts)).toEqual(parts);
    expect(serializeParts([])).toBeUndefined();
});
test("prompts reflect PLAN/BUILD and project directory", () => {
    expect(buildSystemPrompt({ cwd: "/fixture", mode: "PLAN" })).toContain("MODE:PLAN");
    const build = buildSystemPrompt({ cwd: "/fixture", mode: "BUILD" });
    expect(build).toContain("MODE: BUILD"); expect(build).toContain("/fixture");
});
test("TypeScript diagnostics parse Windows paths and line/column", () => {
    expect(parseTscOutput("C:\\src\\file.ts(2,10): error TS2322: Type mismatch\nother output")).toEqual([
        { file: "C:\\src\\file.ts", line: 2, column: 10, severity: "error", code: "TS2322", message: "Type mismatch" },
    ]);
});
