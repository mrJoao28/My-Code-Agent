export function browserCommand(address: string, platform: NodeJS.Platform = process.platform): string[] {
    const url = new URL(address);
    const allowed = url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize"
        || url.origin === "https://chatgpt.com" && url.pathname === "/settings/usage";
    if (!allowed || url.username || url.password) throw new Error("Endereço de autenticação inválido.");
    return platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url.toString()]
        : platform === "darwin" ? ["open", url.toString()] : ["xdg-open", url.toString()];
}
export async function openBrowser(address: string): Promise<void> {
    const command = browserCommand(address);
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const status = await Promise.race([child.exited, new Promise<number>(resolve => { timer = setTimeout(() => resolve(0), 2000); })]);
        if (status !== 0) throw new Error("Não foi possível abrir o navegador. Abra o endereço mostrado no terminal.");
    } finally { clearTimeout(timer); child.unref(); }
}
