import { approvalScope } from "./approval-scope";
import type { CheckpointStore } from "./checkpoints";
import type { ApprovalGrant } from "./permissions";
import { isDockerAvailable } from "./sandbox";
import type { ToolSet } from "ai";
import { toolCallArgsSchema } from "@myagent/shared";
import { approvals, PermissionDeniedError, toolDecision, type ApprovalEvent, type ApprovalManager } from "./permissions";
import { authorizeWorkspace } from "./workspaces";
import { APPROVED_MAIN_PUSH, prepareGitApproval } from "../tools/git-workflow";

export type ToolSecurityOptions = {
    trackExecution?: (run: () => Promise<unknown>) => Promise<unknown>;
    sandboxAvailable?: boolean;
    checkpoints?: CheckpointStore;
    notify?: (event: ApprovalEvent) => Promise<void>;
    manager?: ApprovalManager;
    beforeExecute?: (name: string, input: unknown, id: string) => void | Promise<void>;
    beforeEffect?: (name: string, input: unknown, id: string) => Promise<void>;
    afterExecute?: (name: string, id: string, result: unknown, failed: boolean) => Promise<void>;
    authorize?: (cwd: string) => Promise<string>;
};
export function secureTools<T extends ToolSet>(tools: T, cwd: string, mode: "PLAN" | "BUILD", sessionId: string, security: ToolSecurityOptions = {}): T {
    const secured: ToolSet = {};
    // Git altera HEAD/index/config: chamadas paralelas do modelo precisam observar
    // o resultado anterior, inclusive a parada obrigatória após push.
    let gitQueue: Promise<unknown> = Promise.resolve();
    const gitWrites = new Set(["git_init", "git_switch", "git_remote_add", "git_commit", "git_push", "git_sync"]);
    for (const [name, definition] of Object.entries(tools)) {
        const execute = definition.execute;
        if (!execute) throw new PermissionDeniedError("Ferramenta sem executor: " + name);
        secured[name] = { ...definition, execute: (input, options) => {
            const run = async () => {
                let args = toolCallArgsSchema.parse(structuredClone(input));
                const manager = security.manager ?? approvals;
                const decision = toolDecision(name, mode, security.sandboxAvailable ?? isDockerAvailable(), manager.automationPolicy(sessionId));
                if (decision === "deny") throw new PermissionDeniedError("Ferramenta não permitida: " + name);
                options.abortSignal?.throwIfAborted();
                await (security.authorize ?? authorizeWorkspace)(cwd);
                args = toolCallArgsSchema.parse(await prepareGitApproval(cwd, name, args, options.abortSignal));
                await security.beforeExecute?.(name, args, options.toolCallId);
                let grant: ApprovalGrant | undefined;
                if (decision === "approve") {
                    const scope = await approvalScope(cwd, name, args);
                    grant = await (security.manager ?? approvals).request(sessionId, name, args, security.notify, options.abortSignal, undefined, { ...scope, toolCallId: options.toolCallId });
                }
                options.abortSignal?.throwIfAborted();
                await (security.authorize ?? authorizeWorkspace)(cwd);
                await security.beforeEffect?.(name, args, options.toolCallId);
                const executeOptions = grant?.confirmation ? { ...options, context: { [APPROVED_MAIN_PUSH]: grant.confirmation } } : options;
                let result: unknown;
                try { result = mode === "BUILD" && security.checkpoints
                    ? await security.checkpoints.run(cwd, sessionId, name, args, () => Promise.resolve(execute(args, executeOptions)), options.abortSignal)
                    : await execute(args, executeOptions);
                } catch (error) {
                    await security.afterExecute?.(name, options.toolCallId, "Tool failed: " + (error instanceof Error ? error.message : String(error)), true);
                    throw error;
                }
                result = grant && result && typeof result === "object" ? { ...result, approval: grant } : result;
                await security.afterExecute?.(name, options.toolCallId, result, false);
                return result;
            };
            const dispatch = () => {
                if (!gitWrites.has(name)) return run();
                const execution = gitQueue.then(run);
                gitQueue = execution.then(() => {}, () => {});
                return execution;
            };
            return security.trackExecution ? security.trackExecution(dispatch) : dispatch();
        }};
    }
    return secured as T;
}
