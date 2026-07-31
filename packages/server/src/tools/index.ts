import type { Mode } from "@myagent/database";
import { createBashTool } from "./bash";
import { createListDirectoryTool } from "./list-directory";
import { createWriteFileTool } from "./write-file";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createEditFileTool } from "./edit-file";
import { createReadFileTool } from "./read-file";
import { createWebSearchTool } from "./web-search";
import { createWebFetchTool } from "./web-fetch";
import { createGitStatusTool } from "./git-status";
import { createGitDiffTool } from "./git-diff";
import { createGitLogTool } from "./git-log";
import { createGitCommitTool } from "./git-commit";
import { createTypeCheckTool } from "./type-check";
import { createDeleteFileTool } from "./delete-file";
import { createMoveFileTool } from "./move-file";
import { createApplyPatchTool } from "./apply-patch";
import { createTodoWriteTool } from "./todo-write";

export function createTools(cwd: string, mode: Mode, sessionId: string) {
    const readOnlyTools = {
        read_file: createReadFileTool(cwd),
        list_directory: createListDirectoryTool(cwd),
        glob: createGlobTool(cwd),
        grep: createGrepTool(cwd),
        web_search: createWebSearchTool(),
        web_fetch: createWebFetchTool(),
        git_status: createGitStatusTool(cwd),
        git_diff: createGitDiffTool(cwd),
        git_log: createGitLogTool(cwd),
        type_check: createTypeCheckTool(cwd),
        todo_write: createTodoWriteTool(sessionId)
    };

    if (mode === "PLAN") {
        return readOnlyTools;
    }

    return {
        ...readOnlyTools,
        write_file: createWriteFileTool(cwd),
        edit_file: createEditFileTool(cwd),
        delete_file: createDeleteFileTool(cwd),
        move_file: createMoveFileTool(cwd),
        apply_patch: createApplyPatchTool(cwd),
        bash: createBashTool(cwd),
        git_commit: createGitCommitTool(cwd)
    };
}