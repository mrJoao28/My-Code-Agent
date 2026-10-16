import { z } from "zod";
import { runGit } from "../utils/git";
export const revisionSchema = z.string().max(40).regex(/^(?:[a-fA-F0-9]{4,40}|HEAD(?:~\d{1,3})?)$/, "Use hash hexadecimal ou HEAD/HEAD~N");
export async function resolveCommit(cwd: string, revision = "HEAD", signal?: AbortSignal) {
    const ref = revisionSchema.parse(revision);
    const { stdout } = await runGit(cwd, ["rev-parse", "--verify", ref + "^{commit}"], 5_000, signal);
    const hash = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(hash)) throw new Error("INVALID_COMMIT");
    return hash;
}
