import { myagentHome } from "./home";
import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";

export function localTokenPath(): string {
    return join(myagentHome(), "api-token");
}
export function readLocalToken(path = localTokenPath()): string {
    if (process.env.MYAGENT_API_TOKEN) return validateToken(process.env.MYAGENT_API_TOKEN);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new Error("O arquivo do token local precisa ser privado e não pode ser um link.");
    }
    return validateToken(readFileSync(path, "utf8").trim());
}
export function validateToken(token: string): string {
    if (token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("MYAGENT_API_TOKEN deve conter pelo menos 32 caracteres alfanuméricos, _ ou -.");
    return token;
}
