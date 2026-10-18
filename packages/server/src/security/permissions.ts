import { randomUUID } from "node:crypto";
import type { ChatStreamEvent } from "@myagent/shared";

export type ApprovalEvent = Extract<ChatStreamEvent, { type: "approval-required" }>;
export class PermissionDeniedError extends Error {}
export class ApprovalManager {
    private readonly pending = new Map<string, { sessionId: string; settle: (approved: boolean) => void }>();
    request(sessionId: string, toolName: string, args: ApprovalEvent["args"], notify: (event: ApprovalEvent) => Promise<void>, signal?: AbortSignal, timeoutMs = 120_000): Promise<void> {
        if (signal?.aborted) return Promise.reject(new PermissionDeniedError("Ação cancelada"));
        return new Promise((resolve, reject) => {
            const approvalId = randomUUID();
            const finish = (approved: boolean) => {
                if (!this.pending.delete(approvalId)) return;
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                if (approved && !signal?.aborted) resolve();
                else reject(new PermissionDeniedError("Ação negada, cancelada ou aprovação expirada"));
            };
            const onAbort = () => finish(false);
            const timer = setTimeout(onAbort, timeoutMs);
            this.pending.set(approvalId, { sessionId, settle: finish });
            signal?.addEventListener("abort", onAbort, { once: true });
            void notify({ type: "approval-required", approvalId, toolName, args }).catch(() => finish(false));
        });
    }
    decide(sessionId: string, approvalId: string, approved: boolean): boolean {
        const entry = this.pending.get(approvalId);
        if (!entry || entry.sessionId !== sessionId) return false;
        entry.settle(approved);
        return true;
    }
}
export const approvals = new ApprovalManager();
const READ_TOOLS = new Set(["read_file", "read_files", "project_inspect", "file_outline", "environment_check", "symbol_search", "test_discover", "git_show", "git_blame", "diff_summary", "list_directory", "glob", "grep", "git_status", "git_diff", "git_log", "todo_write"]);
const APPROVAL_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file", "apply_patch", "git_commit", "web_search", "web_fetch"]);
const BUILD_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file", "apply_patch", "bash", "git_commit"]);
const SANDBOX_TOOLS = new Set(["bash", "type_check", "test_run"]);
export function toolDecision(name: string, mode: "PLAN" | "BUILD", sandboxAvailable = false): "allow" | "approve" | "deny" {
    if (mode === "PLAN" && BUILD_TOOLS.has(name)) return "deny";
    if (SANDBOX_TOOLS.has(name)) return sandboxAvailable ? "allow" : "deny";
    if (READ_TOOLS.has(name)) return "allow";
    return APPROVAL_TOOLS.has(name) ? "approve" : "deny";
}
