import type { Mode } from "@myagent/database";
import { SYSTEM_ROLE_TEXT } from "./system";
import { buildCwdNote } from "./coding";
import { PLAN_MODE_TEXT, BUILD_MODE_TEXT } from "./tool-rules";
import { PLAN_WITH_CWD_ADDENDUM } from "./editing";

type SystemPromptParams = {
    cwd: string | null;
    mode: Mode;
};

export function buildSystemPrompt({ cwd, mode }: SystemPromptParams): string {
    const parts: string[] = [];
    parts.push(SYSTEM_ROLE_TEXT);

    if (cwd) {
        parts.push(buildCwdNote(cwd));
    }

    if (mode === "PLAN") {
        parts.push(PLAN_MODE_TEXT);
    } else {
        parts.push(BUILD_MODE_TEXT);
    }

    if (cwd && mode === "PLAN") {
        parts.push(PLAN_WITH_CWD_ADDENDUM);
    }

    return parts.join("");
}
