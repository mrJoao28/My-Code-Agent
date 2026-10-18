import { checkpoints } from "../security/checkpoints";
import type { Mode } from "@myagent/database";
import { secureTools, type ToolSecurityOptions } from "../security/tool-policy";
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
import { createReadFilesTool } from "./read-files";
import { createProjectInspectTool } from "./project-inspect";
import { createFileOutlineTool } from "./file-outline";
import { createEnvironmentCheckTool } from "./environment-check";
import { createSymbolSearchTool } from "./symbol-search";
import { createTestRunTool } from "./test-run";
import { createTestDiscoverTool } from "./test-discover";
import { createGitShowTool } from "./git-show";
import { createGitBlameTool } from "./git-blame";
import { createDiffSummaryTool } from "./diff-summary";
import { ProjectInstructions, withProjectInstructions } from "../lib/project-instructions";
import { isDockerAvailable } from "../security/sandbox";

export function createTools(cwd: string, mode: Mode, sessionId: string, security: ToolSecurityOptions = {}, instructions = new ProjectInstructions(cwd)) {
    security = { ...security, checkpoints: security.checkpoints ?? checkpoints };
    const processesEnabled = security.sandboxAvailable ?? isDockerAvailable();
    const readOnlyTools = {
        read_files: createReadFilesTool(cwd),
        project_inspect: createProjectInspectTool(cwd),
        file_outline: createFileOutlineTool(cwd),
        environment_check: createEnvironmentCheckTool(cwd),
        symbol_search: createSymbolSearchTool(cwd),
        ...(processesEnabled && { test_run: createTestRunTool(cwd, undefined, sessionId) }),
        test_discover: createTestDiscoverTool(cwd),
        git_show: createGitShowTool(cwd),
        git_blame: createGitBlameTool(cwd),
        diff_summary: createDiffSummaryTool(cwd),
        read_file: createReadFileTool(cwd),
        list_directory: createListDirectoryTool(cwd),
        glob: createGlobTool(cwd),
        grep: createGrepTool(cwd),
        web_search: createWebSearchTool(),
        web_fetch: createWebFetchTool(true),
        git_status: createGitStatusTool(cwd),
        git_diff: createGitDiffTool(cwd),
        git_log: createGitLogTool(cwd),
        ...(processesEnabled && { type_check: createTypeCheckTool(cwd, sessionId) }),
        todo_write: createTodoWriteTool(sessionId)
    };

    if (mode === "PLAN") {
        return secureTools(withProjectInstructions(readOnlyTools, instructions), cwd, mode, sessionId, security);
    }

    return secureTools(withProjectInstructions({
        ...readOnlyTools,
        write_file: createWriteFileTool(cwd),
        edit_file: createEditFileTool(cwd),
        delete_file: createDeleteFileTool(cwd),
        move_file: createMoveFileTool(cwd),
        apply_patch: createApplyPatchTool(cwd),
        ...(processesEnabled && { bash: createBashTool(cwd, sessionId) }),
        git_commit: createGitCommitTool(cwd)
    }, instructions), cwd, mode, sessionId, security);
}
