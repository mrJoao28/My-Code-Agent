-- CreateTable
CREATE TABLE "SessionLease" (
    "sessionId" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    CONSTRAINT "SessionLease_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Adição sem reconstruir ou apagar a tabela existente.
ALTER TABLE "Session" ADD COLUMN "workspacePath" TEXT NOT NULL DEFAULT '';
UPDATE "Session" SET "workspacePath" = COALESCE("cwd", '');
CREATE INDEX "Session_workspacePath_updatedAt_idx" ON "Session"("workspacePath", "updatedAt");
