import { tool } from "ai";
import { z } from "zod";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertGitRepo, GitError, gitNetworkOptions, runGit } from "../utils/git";
import { resolveSafePath } from "../utils/path";

const branchSchema = z.string().min(1).max(200);
const remoteSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default("origin");
export const APPROVED_MAIN_PUSH = Symbol("approved-main-push");
type Dependencies = { validateURL?: (url: string) => string; networkOptions?: (cwd: string, signal?: AbortSignal) => Promise<string[]> };

export function validateGitURL(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw new GitError("Remote requer uma URL HTTPS válida sem credenciais."); }
    const hosts = (process.env.MYAGENT_GIT_ALLOWED_HOSTS ?? "github.com").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443"
        || !hosts.includes(url.hostname.toLowerCase()) || /[\s\x00-\x1f\\]/.test(value) || /%[0-9a-f]{2}/i.test(value) || url.pathname === "/")
        throw new GitError("Remote recusado: use HTTPS sem credenciais, query ou fragmento, em um host de MYAGENT_GIT_ALLOWED_HOSTS (padrão github.com).");
    return url.href;
}
export async function validateGitBranch(cwd: string, branch: string, signal?: AbortSignal) {
    if (!branch || branch.length > 200 || branch.startsWith("-") || branch === "HEAD" || branch.includes("@{")) throw new GitError("Nome de branch inválido.");
    try { await runGit(cwd, ["check-ref-format", "--branch", branch], 5_000, signal); }
    catch { signal?.throwIfAborted(); throw new GitError("Nome de branch inválido."); }
}
async function remoteURL(cwd: string, remote: string, validate: (value: string) => string, signal?: AbortSignal) {
    const urls = (await runGit(cwd, ["config", "--local", "--get-all", `remote.${remote}.url`], 5_000, signal)).stdout.trim().split(/\r?\n/);
    if (urls.length !== 1) throw new GitError("Remote deve possuir uma única URL.");
    const url = validate(urls[0]!);
    let pushURLs = "";
    try { pushURLs = (await runGit(cwd, ["config", "--local", "--get-all", `remote.${remote}.pushurl`], 5_000, signal)).stdout.trim(); } catch { signal?.throwIfAborted(); }
    if (pushURLs) throw new GitError("Remote com pushurl separado não é permitido.");
    return url;
}

// Executado antes da aprovação e novamente no executor. URL nunca vem só do modelo.
export async function prepareGitApproval(cwd: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, dependencies: Dependencies = {}) {
    const validate = dependencies.validateURL ?? validateGitURL;
    if (name === "git_remote_add") return { ...args, url: validate(String(args.url)) };
    if (name !== "git_push" && name !== "git_sync") return args;
    await assertGitRepo(cwd, signal);
    const remote = remoteSchema.parse(args.remote);
    const branch = branchSchema.parse(args.branch ?? "main");
    await validateGitBranch(cwd, branch, signal);
    const url = await remoteURL(cwd, remote, validate, signal);
    if (args.url !== undefined && args.url !== url) throw new GitError("A URL do remote mudou; solicite uma nova aprovação.");
    return { ...args, remote, branch, url };
}

export function createGitInitTool(cwd: string) {
    return tool({ description: "Inicializa Git com main, com aprovação, somente fora de qualquer repositório e sem .git existente. Crie primeiro os arquivos pedidos; commit é separado.",
        inputSchema: z.object({}).strict(), execute: async (_input, { abortSignal }) => {
            const root = await resolveSafePath(cwd, ".");
            for (let directory = root; ; directory = dirname(directory)) {
                abortSignal?.throwIfAborted();
                for (const path of [join(directory, ".git"), join(directory, "HEAD")]) {
                    try {
                        const info = await lstat(path);
                        if (path.endsWith(".git") || info.isFile() && await lstat(join(directory, "objects")).then(s => s.isDirectory(), () => false))
                            throw new GitError("git_init recusado: workspace ou diretório pai já pertence a um repositório Git.");
                    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                }
                if (dirname(directory) === directory) break;
            }
            await runGit(root, ["init", "-b", "main"], 15_000, abortSignal);
            return { initialized: true, branch: "main" };
        } });
}
export function createGitSwitchTool(cwd: string) {
    return tool({ description: "Cria (create=true) ou troca de branch com aprovação. Não faz delete, force ou descarte de alterações.",
        inputSchema: z.object({ branch: branchSchema, create: z.boolean().default(false) }).strict(),
        execute: async ({ branch, create }, { abortSignal }) => {
            await assertGitRepo(cwd, abortSignal); await validateGitBranch(cwd, branch, abortSignal);
            await runGit(cwd, ["switch", "--no-guess", ...(create ? ["-c"] : []), branch], 15_000, abortSignal);
            return { branch, created: create };
        } });
}
export function createGitRemoteAddTool(cwd: string, dependencies: Dependencies = {}) {
    return tool({ description: "Adiciona remote HTTPS aprovado (github.com por padrão), sem credenciais. Recusa substituir outra URL e nunca memoriza aprovação.",
        inputSchema: z.object({ remote: remoteSchema, url: z.string().min(1).max(2048) }).strict(),
        execute: async ({ remote, url: input }, { abortSignal }) => {
            await assertGitRepo(cwd, abortSignal);
            const url = (dependencies.validateURL ?? validateGitURL)(input);
            let previous: string | undefined;
            try { previous = (await runGit(cwd, ["config", "--local", "--get-all", `remote.${remote}.url`], 5_000, abortSignal)).stdout.trim(); } catch { abortSignal?.throwIfAborted(); }
            if (previous !== undefined) {
                if (previous !== url) throw new GitError("Remote já existe com outra URL; não será substituído.");
                return { remote, url, added: false };
            }
            await runGit(cwd, ["remote", "add", remote, url], 15_000, abortSignal);
            return { remote, url, added: true };
        } });
}
const transferSchema = z.object({ remote: remoteSchema, branch: branchSchema, url: z.string().max(2048).optional() }).strict();
export function createGitPushTool(cwd: string, dependencies: Dependencies = {}) {
    return tool({ description: "Envia apenas a branch explícita por HTTPS com aprovação a cada chamada. Sem force, delete, mirror ou tags. main/master exigem confirmação explícita adicional do usuário. Depois do sucesso pare e peça liberação no GitHub.",
        inputSchema: transferSchema, execute: async (input, { abortSignal, context }) => {
            const { remote, branch, url } = await prepareGitApproval(cwd, "git_push", input, abortSignal, dependencies) as { remote: string; branch: string; url: string };
            if (["main", "master"].includes(branch) && (context as Record<symbol, unknown> | undefined)?.[APPROVED_MAIN_PUSH] !== branch)
                throw new GitError("Push para main/master exige confirmação explícita do usuário na aprovação.");
            const current = (await runGit(cwd, ["symbolic-ref", "--short", "HEAD"], 5_000, abortSignal)).stdout.trim();
            if (current !== branch) throw new GitError("Push só é permitido para a branch atual.");
            const options = await (dependencies.networkOptions ?? gitNetworkOptions)(cwd, abortSignal);
            await runGit(cwd, [...options, "-c", "push.followTags=false", "push", "--porcelain", "--no-verify", "--signed=false", "--recurse-submodules=no", url, `refs/heads/${branch}:refs/heads/${branch}`], 60_000, abortSignal, true);
            return { remote, url, branch, pushed: true, awaitingRelease: true, message: `Branch ${branch} enviada. Libere o PR no GitHub e avise para continuar. Não inicie outra branch antes desse aviso.` };
        } });
}
export function createGitSyncTool(cwd: string, dependencies: Dependencies = {}) {
    return tool({ description: "Após o usuário liberar o PR e pedir continuação: fetch da principal (main/master) e merge --ff-only na principal local. Recusa alterações staged ou no workspace; não resolve conflitos.",
        inputSchema: transferSchema.extend({ branch: z.enum(["main", "master"]).default("main") }), execute: async (input, { abortSignal }) => {
            const { remote, branch, url } = await prepareGitApproval(cwd, "git_sync", input, abortSignal, dependencies) as { remote: string; branch: string; url: string };
            if ((await runGit(cwd, ["status", "--porcelain"], 5_000, abortSignal)).stdout.trim()) throw new GitError("git_sync requer workspace e staging limpos.");
            const current = (await runGit(cwd, ["symbolic-ref", "--short", "HEAD"], 5_000, abortSignal)).stdout.trim();
            if (current !== branch) throw new GitError("Troque para a branch principal antes de git_sync.");
            const options = await (dependencies.networkOptions ?? gitNetworkOptions)(cwd, abortSignal);
            await runGit(cwd, [...options, "fetch", "--no-tags", "--no-recurse-submodules", url, `refs/heads/${branch}`], 60_000, abortSignal, true);
            await runGit(cwd, ["merge", "--ff-only", "--no-edit", "--no-verify-signatures", "--no-gpg-sign", "FETCH_HEAD"], 15_000, abortSignal);
            return { remote, branch, url, synced: true };
        } });
}
