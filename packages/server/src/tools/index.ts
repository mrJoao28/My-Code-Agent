import type { Mode } from "@myagent/database";
import { createBashTool } from "./bash";
import { createListDirectoryTool } from "./list-directory";
import { createWriteFIleTool } from "./write-file";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { ccreatedEditFileTool } from "./edit-file";
import { createReadFIleTool } from "./read-file";

export function createTools(cwd: string, mode: Mode) {
    const readOnlyTools = {
        read_file: createReadFIleTool(cwd),
        list_directory: createListDirectoryTool(cwd),
        glob: createGlobTool(cwd),
        grep: createGrepTool(cwd)
    };

    if (mode === "PLAN") {
        return readOnlyTools;
    }

    return {
        ...readOnlyTools,
        write_file: createWriteFIleTool(cwd),
        edit_file: ccreatedEditFileTool(cwd),
        bash: createBashTool(cwd)
    };
}