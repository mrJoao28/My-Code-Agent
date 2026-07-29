import type { Mode } from "@myagent/database";
import { createBashTool } from "./bash";
import { createListDirectoryTool } from "./list-directory";
import { createWriteFIleTool } from "./write-file";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { ccreatedEditFileTool } from "./edit-file";
import { createReadFIleTool } from "./read-file";

export function createTools(cwd: string, mode: Mode) {
    return {
        read_file: createReadFIleTool(cwd),
        write_file: createWriteFIleTool(cwd),
        edit_file: ccreatedEditFileTool(cwd),
        list_directory: createListDirectoryTool(cwd),
        glob: createGlobTool(cwd),
        grep: createGrepTool(cwd),
        bash: createBashTool(cwd)
    };
}