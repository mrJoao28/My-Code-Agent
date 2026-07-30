import pino from "pino";

export const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: {
        service: "myagent-server"
    },
    timestamp: pino.stdTimeFunctions.isoTime
});

export function generateRequestId(): string {
    return crypto.randomUUID();
}
