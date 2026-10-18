import { approvalScope } from "./approval-scope";
import type { CheckpointStore } from "./checkpoints";
import type { ApprovalGrant } from "./permissions";
import { isDockerAvailable } from "./sandbox";
import type { ToolSet } from "ai";
import { toolCallArgsSchema } from "@myagent/shared";
import { approvals, PermissionDeniedError, toolDecision, type ApprovalEvent, type ApprovalManager } from "./permissions";
import { authorizeWorkspace } from "./workspaces";

export type ToolSecurityOptions = {
    sandboxAvailable?: boolean;
    checkpoints?: CheckpointStore;
    notify?: (event: ApprovalEvent) => Promise<void>;
    manager?: ApprovalManager;
    beforeExecute?: (name: string, input: unknown) => void;
    authorize?: (cwd: string) => Promise<string>;
};
export function secureTools<T extends ToolSet>(tools: T, cwd: string, mode: "PLAN" | "BUILD", sessionId: string, security: ToolSecurityOptions = {}): T {
    const secured: ToolSet = {};
    for (const [name, definition] of Object.entries(tools)) {
        const execute = definition.execute;
        if (!execute) throw new PermissionDeniedError("Ferramenta sem executor: " + name);
        secured[name] = { ...definition, execute: async (input, options) => {
            const args = toolCallArgsSchema.parse(structuredClone(input));
            const decision = toolDecision(name, mode, security.sandboxAvailable ?? isDockerAvailable());
            if (decision === "deny") throw new PermissionDeniedError("Ferramenta não permitida: " + name);
            options.abortSignal?.throwIfAborted();
            await (security.authorize ?? authorizeWorkspace)(cwd);
            security.beforeExecute?.(name, args);
            let grant: ApprovalGrant | undefined;
            if (decision === "approve") {
                const scope = await approvalScope(cwd, name, args);
                grant = await (security.manager ?? approvals).request(sessionId, name, args, security.notify, options.abortSignal, undefined, { ...scope, toolCallId: options.toolCallId });
            }
            options.abortSignal?.throwIfAborted();
            await (security.authorize ?? authorizeWorkspace)(cwd);
            const result = mode === "BUILD" && security.checkpoints
                ? await security.checkpoints.run(cwd, sessionId, name, args, () => Promise.resolve(execute(args, options)), options.abortSignal)
                : await execute(args, options);
            return grant && result && typeof result === "object" ? { ...result, approval: grant } : result;
        }};
    }
    return secured as T;
}
