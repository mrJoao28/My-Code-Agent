import { hc } from "hono/client";
import type { AppType } from "@myagent/server";
import { readLocalToken } from "@myagent/shared/local-auth";
const apiURL = new URL(process.env.API_URL ?? "http://127.0.0.1:3000");
if (apiURL.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(apiURL.hostname) || apiURL.username || apiURL.password) {
    throw new Error("API_URL deve apontar para a API HTTP local em loopback.");
}
export const appClient = hc<AppType>(apiURL.toString(), {
    headers: () => ({ Authorization: "Bearer " + readLocalToken() }),
    init: { redirect: "error" },
});
