import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createMemoryRouter,RouterProvider } from "react-router";
import { RouteError } from "./components/route-error";
import { RootLayout } from "./layouts/root-layout";
import { Home } from "./screens/home";
import { NewSession } from "./screens/new-session";
import { Session } from "./screens/session";
import { configureApiClient, appClient } from "./lib/api-client";
declare const MYAGENT_BUNDLED: boolean;

export async function startCui(options: { apiUrl: string; token: string; workspace: string; sessionId?: string; signal?: AbortSignal; dockerAvailable?: boolean }) {
options.signal?.throwIfAborted();
configureApiClient(options);
let dockerAvailable = options.dockerAvailable;
if (dockerAvailable === undefined) {
  const status = await appClient.runtime.$get();
  if (!status.ok) throw new Error("Não foi possível consultar a API local.");
  dockerAvailable = (await status.json()).dockerAvailable;
}
const router = createMemoryRouter([
  {
    path:"/",
    element:<RootLayout/>,
    errorElement:<RouteError/>,
    children:[
      {index:true,element:<Home/>},
      {path:"sessions/new",element:<NewSession/>},
      {path:"sessions/:id",element:<Session/>},
    ]
  }
], { initialEntries: [options.sessionId ? `/sessions/${options.sessionId}` : "/"] })


function App() {
  return (
   <RouterProvider router={router}/>
  );
}

let finish!: () => void;
const closed = new Promise<void>(resolve => { finish = resolve; });
let root: ReturnType<typeof createRoot> | undefined;
const renderer = await createCliRenderer({
  targetFps:60,
  exitOnCtrlC:false,
  onDestroy: () => {
    options.signal?.removeEventListener("abort", close);
    try { root?.unmount(); } finally { router.dispose(); finish(); }
  },
});
function close() { renderer.destroy(); }
options.signal?.addEventListener("abort", close, { once: true });
try {
  root = createRoot(renderer);
  root.render(<box flexDirection="column" flexGrow={1}>
    {dockerAvailable === false && <text fg="gray">Docker indisponível: comandos desativados</text>}
    <App />
  </box>);
  if (options.signal?.aborted) close();
  return { closed, close };
} catch (error) { close(); throw error; }
}

if (import.meta.main && (typeof MYAGENT_BUNDLED === "undefined" || !MYAGENT_BUNDLED)) {
  const { readLocalToken } = await import("@myagent/shared/local-auth");
  const cui = await startCui({ apiUrl: process.env.API_URL ?? "http://127.0.0.1:3000", token: readLocalToken(), workspace: process.cwd() });
  await cui.closed;
}
