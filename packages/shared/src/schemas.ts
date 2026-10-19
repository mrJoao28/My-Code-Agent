import { z } from "zod"

export const MAX_MESSAGE_LENGTH = 9_000;
export const messageContentSchema = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);
export const SESSION_APPROVAL_FORBIDDEN: readonly string[] = ["git_commit", "delete_file", "git_push", "git_remote_add", "git_init"];

export const toolCallArgsSchema = z.record(z.string(), z.json())

const toolLimitWarningSchema = z.object({
    type: z.literal("tool-limit-warning"),
    limit: z.number().int().positive().max(200),
})
const contextWarningSchema = z.object({
    type: z.literal("context-warning"), contextWindow: z.number().int().positive(),
    estimated: z.boolean(), toolCount: z.number().int().nonnegative(), message: z.string(),
});

export const messagePartSchema = z.discriminatedUnion("type", [
    contextWarningSchema,
    toolLimitWarningSchema,
    z.object({
        type: z.literal("reasoning"),
        text: z.string()
    }),
    z.object({
        type: z.literal("tool-call"),
        id: z.string(),
        name: z.string(),
        args: toolCallArgsSchema,
        execution: z.enum(["pending", "started"]).optional(),
    }),
    z.object({
        type: z.literal("tool-result"),
        id: z.string(),
        name: z.string(),
        result: z.string()
    }),
    z.object({
        type: z.literal("text"),
        text: z.string()
    })
])
export const messagePartsSchema = z.array(messagePartSchema)

// Antes: `z.infer<typeof messagePartsSchema>` — isso tornava MessagePart um
// array (MessagePart[][] em qualquer lugar que fizesse `parts: MessagePart[]`)
// e quebrava o Extract<MessagePart, {...}> no route, que precisa de uma union.
export type MessagePart = z.infer<typeof messagePartSchema>
export type MessageParts = z.infer<typeof messagePartsSchema>

export const chatStreamEventSchema = z.discriminatedUnion("type", [
    contextWarningSchema,
    toolLimitWarningSchema,
    z.object({ type: z.literal("generation-started"), messageId: z.string() }),
    z.object({
        type: z.literal("usage"),
        totalTokens: z.number().int().min(0).max(2_147_483_647)
    }),
    z.object({
        type: z.literal("approval-required"),
        approvalId: z.string(),
        confirmation: z.string().max(200).optional(),
        scope: z.string().optional(),
        allowSession: z.boolean().optional(),
        toolCallId: z.string().optional(),
        toolName: z.string(),
        args: toolCallArgsSchema,
    }),
    z.object({
        type: z.literal("text-delta"),
        text: z.string()
    }),
    z.object({
        type: z.literal("reasoning-delta"),
        text: z.string()
    }),
    z.object({
        type: z.literal("tool-call"),
        toolCallId: z.string(),
        toolName: z.string(),
        args: toolCallArgsSchema
    }),
    z.object({
        type: z.literal("tool-result"),
        toolCallId: z.string(),
        toolName: z.string(),
        result: z.string()
    }),
    z.object({
        type: z.literal("done"),
        messageId: z.string(),
        durationMs: z.number()
    }),
    z.object({
        type: z.literal("error"),
        kind: z.literal("context").optional(),
        message: z.string(),
        messageId: z.string().optional(),
        parts: messagePartsSchema.optional(),
    })
])

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>
