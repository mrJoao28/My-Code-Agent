import type { Mode } from "@myagent/database";
import { createBashTool } from "./bash";
import { createListDirectoryTool } from "./list-directory";
import { createWriteFileTool } from "./write-file";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createEditFileTool } from "./edit-file";
import { createReadFileTool } from "./read-file";

export function createTools(cwd: string, mode: Mode) {
    const readOnlyTools = {
        read_file: createReadFileTool(cwd),
        list_directory: createListDirectoryTool(cwd),
        glob: createGlobTool(cwd),
        grep: createGrepTool(cwd)
    };

    if (mode === "PLAN") {
        return readOnlyTools;
    }

    return {
        ...readOnlyTools,
        write_file: createWriteFileTool(cwd),
        edit_file: createEditFileTool(cwd),
        bash: createBashTool(cwd)
    };
}
