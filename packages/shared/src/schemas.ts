import { z } from "zod"

export const toolCallArgsSchema = z.record(z.string(), z.json())

export const messagePartSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("reasoning"),
        text: z.string()
    }),
    z.object({
        type: z.literal("tool-call"),
        id: z.string(),
        name: z.string(),
        args: toolCallArgsSchema
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
        message: z.string()
    })
])

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>