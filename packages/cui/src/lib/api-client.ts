import { hc } from "hono/client"
import type { AppType } from "@myagent/server"

export const appClient = hc<AppType>(
    process.env.API_URL ?? "http://localhost:3000"
)