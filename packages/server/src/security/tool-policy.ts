import { approvalScope } from "./approval-scope";
import type { CheckpointStore } from "./checkpoints";
import type { ApprovalGrant } from "./permissions";
import { isDockerAvailable } from "./sandbox";
import type { ToolSet } from "ai";
import { toolCallArgsSchema } from "@myagent/shared";
import { approvals, PermissionDeniedError, toolDecision, type ApprovalEvent, type ApprovalManager } from "./permissions";
import { authorizeWorkspace } from "./workspaces";

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
    for (const [name, definition] of Object.entries(tools)) {
        const execute = definition.execute;
        if (!execute) throw new PermissionDeniedError("Ferramenta sem executor: " + name);
        secured[name] = { ...definition, execute: (input, options) => {
            const run = async () => {
                const args = toolCallArgsSchema.parse(structuredClone(input));
                const decision = toolDecision(name, mode, security.sandboxAvailable ?? isDockerAvailable());
                if (decision === "deny") throw new PermissionDeniedError("Ferramenta não permitida: " + name);
                options.abortSignal?.throwIfAborted();
                await (security.authorize ?? authorizeWorkspace)(cwd);
                await security.beforeExecute?.(name, args, options.toolCallId);
                let grant: ApprovalGrant | undefined;
                if (decision === "approve") {
                    const scope = await approvalScope(cwd, name, args);
                    grant = await (security.manager ?? approvals).request(sessionId, name, args, security.notify, options.abortSignal, undefined, { ...scope, toolCallId: options.toolCallId });
                }
                options.abortSignal?.throwIfAborted();
                await (security.authorize ?? authorizeWorkspace)(cwd);
                await security.beforeEffect?.(name, args, options.toolCallId);
                let result: unknown;
                try { result = mode === "BUILD" && security.checkpoints
                    ? await security.checkpoints.run(cwd, sessionId, name, args, () => Promise.resolve(execute(args, options)), options.abortSignal)
                    : await execute(args, options);
                } catch (error) {
                    await security.afterExecute?.(name, options.toolCallId, "Tool failed: " + (error instanceof Error ? error.message : String(error)), true);
                    throw error;
                }
                result = grant && result && typeof result === "object" ? { ...result, approval: grant } : result;
                await security.afterExecute?.(name, options.toolCallId, result, false);
                return result;
            };
            return security.trackExecution ? security.trackExecution(run) : run();
        }};
    }
    return secured as T;
}
