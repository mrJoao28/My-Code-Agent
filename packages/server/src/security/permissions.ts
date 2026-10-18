import { randomUUID } from "node:crypto";
import type { ChatStreamEvent } from "@myagent/shared";

export type ApprovalEvent = Extract<ChatStreamEvent, { type: "approval-required" }>;
export class PermissionDeniedError extends Error {}
export type ApprovalGrant = { choice: "once" | "session" | "cached"; scope?: string };
type RequestScope = { key: string; label: string; allowSession: boolean; toolCallId?: string };
export class ApprovalManager {
    private readonly grants = new Map<string, Set<string>>();
    forget(sessionId: string) {
        this.grants.delete(sessionId);
        for (const pending of this.pending.values()) if (pending.sessionId === sessionId) pending.settle(false);
    }
    sessions() { return [...this.grants.keys()]; }
    private readonly pending = new Map<string, { sessionId: string; allowSession: boolean; settle: (approved: boolean, remember?: boolean) => void }>();
    request(sessionId: string, toolName: string, args: ApprovalEvent["args"], notify: ((event: ApprovalEvent) => Promise<void>) | undefined, signal?: AbortSignal, timeoutMs = 120_000, scope?: RequestScope): Promise<ApprovalGrant> {
        if (signal?.aborted) return Promise.reject(new PermissionDeniedError("Ação cancelada"));
        const allowSession = !!scope?.allowSession && !["git_commit", "delete_file"].includes(toolName);
        if (allowSession && scope && this.grants.get(sessionId)?.has(scope.key)) return Promise.resolve({ choice: "cached", scope: scope.label });
        if (!notify) return Promise.reject(new PermissionDeniedError("A ferramenta requer aprovação explícita: " + toolName));
        return new Promise((resolve, reject) => {
            const approvalId = randomUUID();
            const finish = (approved: boolean, remember = false) => {
                if (!this.pending.delete(approvalId)) return;
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                if (approved && !signal?.aborted) {
                    if (remember && allowSession && scope) {
                        const grants = this.grants.get(sessionId) ?? new Set<string>();
                        if (grants.size >= 256) { reject(new PermissionDeniedError("Limite de permissões da sessão atingido; use Y para permitir uma vez.")); return; }
                        grants.add(scope.key); this.grants.set(sessionId, grants);
                    }
                    resolve({ choice: remember ? "session" : "once", ...(scope && { scope: scope.label }) });
                }
                else reject(new PermissionDeniedError("Ação negada, cancelada ou aprovação expirada"));
            };
            const onAbort = () => finish(false);
            const timer = setTimeout(onAbort, timeoutMs);
            this.pending.set(approvalId, { sessionId, allowSession, settle: finish });
            signal?.addEventListener("abort", onAbort, { once: true });
            void notify({ type: "approval-required", approvalId, toolName, args, ...(scope && { scope: scope.label, allowSession, toolCallId: scope.toolCallId }) }).catch(() => finish(false));
        });
    }
    decide(sessionId: string, approvalId: string, approved: boolean, remember = false): boolean {
        const entry = this.pending.get(approvalId);
        if (!entry || entry.sessionId !== sessionId || remember && (!approved || !entry.allowSession)) return false;
        entry.settle(approved, remember);
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
