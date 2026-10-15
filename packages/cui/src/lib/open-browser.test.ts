import { expect, test } from "bun:test";
import { browserCommand } from "./open-browser";

test("login URL is passed as one argument without a shell on every platform", () => {
    const url = "https://auth.openai.com/api/accounts/authorize?state=fixture&scope=openid";
    expect(browserCommand(url, "win32")).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", url]);
    expect(browserCommand(url, "darwin")).toEqual(["open", url]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", url]);
    expect(browserCommand("https://chatgpt.com/settings/usage", "linux")).toHaveLength(2);
});
test.each(["http://auth.openai.com/api/accounts/authorize", "https://auth.openai.com.attacker.example/api/accounts/authorize", "https://user:secret@auth.openai.com/api/accounts/authorize", "file:///C:/Windows/system32/cmd.exe", "https://chatgpt.com/attacker", "https://auth.openai.com/other"])("browser launcher rejects unexpected destinations: %s", url => {
    expect(() => browserCommand(url)).toThrow();
});
