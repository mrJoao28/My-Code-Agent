import { isDockerAvailable } from "./sandbox";
import type { ToolSet } from "ai";
import { toolCallArgsSchema } from "@myagent/shared";
import { approvals, PermissionDeniedError, toolDecision, type ApprovalEvent, type ApprovalManager } from "./permissions";
import { authorizeWorkspace } from "./workspaces";

export type ToolSecurityOptions = {
    sandboxAvailable?: boolean;
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
            if (decision === "approve") {
                if (!security.notify) throw new PermissionDeniedError("A ferramenta requer aprovação explícita: " + name);
                await (security.manager ?? approvals).request(sessionId, name, args, security.notify, options.abortSignal);
            }
            options.abortSignal?.throwIfAborted();
            await (security.authorize ?? authorizeWorkspace)(cwd);
            return await execute(args, options);
        }};
    }
    return secured as T;
}
