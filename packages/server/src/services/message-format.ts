import type { Mode, MessageStatus } from "@myagent/database/enums";
import type { Prisma } from "@myagent/database";
import type { MessagePart } from "@myagent/shared";
import { messagePartSchema } from "@myagent/shared";
import { contextFromMessages, fitContextWindow } from "./session-context";
export function buildConversationHistory(messages: { role: "USER" | "ASSISTANT" | "ERROR"; content: string; status: MessageStatus; parts?: unknown }[]) {
    return fitContextWindow(contextFromMessages(messages)).messages;
}
export function getResumableUserMessage(messages: { role: "USER" | "ASSISTANT" | "ERROR"; model: string; mode: Mode }[]) {
    const last = messages.at(-1);
    return last?.role === "USER" ? last : null;
}
export function extractFullText(parts: MessagePart[]): string {
    return parts.filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text").map(p => p.text).join("");
}
export function serializeParts(parts: MessagePart[]): Prisma.InputJsonValue | undefined {
    return parts.length ? messagePartSchema.array().parse(parts) : undefined;
}
