import { homedir } from "node:os";
import { resolve } from "node:path";

export function myagentHome(): string {
    return resolve(process.env.MYAGENT_HOME || process.env.MYAGENT_CONFIG_DIR || resolve(homedir(), ".myagent"));
}
