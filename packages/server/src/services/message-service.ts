import type { Mode, MessageStatus } from "@myagent/database";
import { db, Prisma } from "@myagent/database";
import type { MessagePart } from "@myagent/shared";
import { messagePartSchema } from "@myagent/shared";

export function buildConversationHistory(
    messages: { role: "USER" | "ASSISTANT" | "ERROR"; content: string; status: MessageStatus }[]
): { role: "user" | "assistant"; content: string }[] {
    return messages.flatMap((m) => {
        if (m.role === "ERROR") return [];
        if (m.role === "ASSISTANT" && m.content.length === 0) return [];
        return [{ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content }];
    });
}

export function getResumableUserMessage(
    messages: { role: "USER" | "ASSISTANT" | "ERROR"; model: string; mode: Mode }[]
) {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "USER") {
        return null;
    }
    return lastMessage;
}

export function extractFullText(parts: MessagePart[]): string {
    return parts
        .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");
}

export function serializeParts(parts: MessagePart[]): Prisma.InputJsonValue | undefined {
    return parts.length > 0 ? messagePartSchema.array().parse(parts) : undefined;
}

/**
 * BUGFIX: `Session.updatedAt` é `@updatedAt` no schema (pensado para
 * refletir a última atividade da sessão), mas nenhum lugar do código
 * chamava `session.update`, então o campo nunca mudava depois da
 * criação da sessão. Isso fazia a listagem de sessões (ordenada por
 * `updatedAt`) nunca trazer para o topo uma sessão em que o usuário
 * acabou de mandar uma mensagem nova.
 *
 * Chame esta função sempre que uma mensagem (USER, ASSISTANT ou ERROR)
 * for persistida em uma sessão. Falhas aqui não devem derrubar o fluxo
 * principal de chat, por isso o erro é apenas logado via `.catch`.
 */
export async function touchSession(sessionId: string): Promise<void> {
    await db.session
        .update({ where: { id: sessionId }, data: { updatedAt: new Date() } })
        .catch(() => {
            // A sessão pode ter sido removida concorrentemente; não é
            // crítico para o fluxo de geração, então apenas ignoramos.
        });
}