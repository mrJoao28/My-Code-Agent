import { hc } from "hono/client";
import type { AppType } from "@myagent/server";
import { readLocalToken } from "@myagent/shared/local-auth";
let configuredToken: string | undefined;
let configuredWorkspace: string | undefined;
function createClient(url: string) {
const apiURL = new URL(url);
if (apiURL.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(apiURL.hostname) || apiURL.username || apiURL.password) {
    throw new Error("API_URL deve apontar para a API HTTP local em loopback.");
}
return hc<AppType>(apiURL.toString(), {
    headers: () => ({ Authorization: "Bearer " + (configuredToken ?? readLocalToken()), ...(configuredWorkspace && { "X-Myagent-Workspace": configuredWorkspace }) }),
    init: { redirect: "error" },
});
}
export let appClient = createClient(process.env.API_URL ?? "http://127.0.0.1:3000");
export function configureApiClient(options: { apiUrl: string; token: string; workspace: string }) {
    configuredToken = options.token;
    configuredWorkspace = options.workspace;
    appClient = createClient(options.apiUrl);
}
export function currentWorkspace() { return configuredWorkspace ?? process.cwd(); }
