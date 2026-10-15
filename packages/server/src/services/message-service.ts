import { db } from "@myagent/database";
export { buildConversationHistory, getResumableUserMessage, extractFullText, serializeParts } from "./message-format";
export async function touchSession(sessionId: string): Promise<void> {
    await db.session.update({ where: { id: sessionId }, data: { updatedAt: new Date() } }).catch(() => {});
}
