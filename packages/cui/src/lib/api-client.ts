import {hc} from "hono/client"
import type {AppType} from "@myagent/server"


export const appCLient = hc<AppType>(
    process.env.API_URL ?? "https://localhost:3000"
)

