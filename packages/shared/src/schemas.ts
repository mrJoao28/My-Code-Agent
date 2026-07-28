import {z} from "zod"

export const toolCallArgsSchema = z.record(z.string(),z.json())

export const messagePartSchema = z.discriminatedUnion("type",[
    z.object({
        type:z.literal("resoning"),
        text:z.string()
    }),
    z.object({
        type:z.literal("tool-call"),
        id:z.string(),
        name:z.string(),
        args:toolCallArgsSchema,
        result:z.string().optional()
    }),
    z.object({
        type:z.literal("text"),
        text:z.string()
    })
])
export const messagePartsSchema = z.array(messagePartSchema)

export type MessagePart = z.infer<typeof messagePartsSchema>


export const chatStreamEventSchema = z.discriminatedUnion("type",[
    z.object({
        type:z.literal("text-delta"),
        text:z.string()
    }),
    z.object({
        type:z.literal("resoning-delta"),
        text:z.string()
    }),
    z.object({
        type:z.literal("too-call"),
        toolCallId:z.string(),
        toolName:z.string(),
  args:toolCallArgsSchema
    }),
    z.object({
        type:z.literal("tool-result"),
        toolCallId:z.string(),
        result:z.string()
    }),
    z.object({
        type:z.literal("done"),
        messageId:z.string(),
        durationMs:z.number()
    }),
    z.object({
        type:z.literal("error"),
        message:z.string()
    })
])

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>
