-- Message.status já é TEXT no SQLite e aceita IN_PROGRESS sem reescrever as mensagens.
ALTER TABLE "Message" ADD COLUMN "generationId" TEXT;
CREATE INDEX "Message_generationId_idx" ON "Message"("generationId");
ALTER TABLE "Session" ADD COLUMN "retentionWarnedAt" DATETIME;
