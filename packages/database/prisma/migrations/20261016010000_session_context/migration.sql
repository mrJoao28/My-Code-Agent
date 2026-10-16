CREATE TABLE "SessionContext" (
    "sessionId" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "tokenLimit" INTEGER NOT NULL DEFAULT 16384,
    "estimatedTokens" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SessionContext_pkey" PRIMARY KEY ("sessionId"),
    CONSTRAINT "SessionContext_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
