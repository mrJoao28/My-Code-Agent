import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createWebFetchTool, isDisallowedIp, requestPinned } from "./web-fetch";
import { execute } from "../test-support";

const blocked = [
    "0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255", "127.0.0.1", "127.255.255.255",
    "169.254.0.0", "169.254.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255",
    "100.64.0.0", "100.127.255.255", "192.0.0.0", "192.0.0.255", "192.0.2.0", "192.0.2.255",
    "198.51.100.0", "198.51.100.255", "203.0.113.0", "203.0.113.255", "198.18.0.0", "198.19.255.255",
    "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255", "::", "::1", "0:0:0:0:0:0:0:1",
    "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:8.8.8.8",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "ff02::1", "not-an-ip",
];
test.each(blocked)("BlockList rejects reserved address %s", address => { expect(isDisallowedIp(address)).toBe(true); });
test.each(["8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "198.17.255.255", "198.20.0.0", "2606:4700:4700::1111", "2001:4860:4860::8888"])("public address remains available: %s", address => { expect(isDisallowedIp(address)).toBe(false); });

test.each(["http://2130706433", "http://0177.0.0.1", "http://0x7f000001", "http://127.1", "http://[::ffff:7f00:1]", "http://[::1]", "http://[64:ff9b::7f00:1]", "http://[2002:7f00:1::]"])("URL normalization cannot bypass SSRF: %s", async url => {
    const request = mock(async () => new Response("unreachable"));
    await expect(execute(createWebFetchTool(false, { resolve: async () => [], request }), { url })).rejects.toThrow("bloqueado");
    expect(request).not.toHaveBeenCalled();
});

test("a rebinding resolver is used once and the transport receives only the validated IP", async () => {
    let lookups = 0;
    const resolve = async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    const request = mock(async (url, address) => {
        expect(url.hostname).toBe("rebind.example"); expect(address).toEqual({ address: "93.184.216.34", family: 4 });
        return new Response("public");
    });
    expect((await execute(createWebFetchTool(false, { resolve, request }), { url: "https://rebind.example" })).content).toBe("public");
    expect(lookups).toBe(1); expect(request).toHaveBeenCalledTimes(1);
});

test.each(["http://127.0.0.1/private", "https://rebind.example/next", "http://[::ffff:7f00:1]/"])("every redirect is revalidated before opening %s", async location => {
    let lookups = 0;
    const request = mock(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(execute(createWebFetchTool(false, { resolve: async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "10.1.2.3", family: 4 }], request }), { url: "https://rebind.example/start" })).rejects.toThrow("bloqueado");
    expect(request).toHaveBeenCalledTimes(1);
});

test("a hostname with mixed public/private records fails closed", async () => {
    const request = mock(async () => new Response("unreachable"));
    await expect(execute(createWebFetchTool(false, { resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:7f00:1", family: 6 }], request }), { url: "https://mixed.example" })).rejects.toThrow("bloqueado");
    expect(request).not.toHaveBeenCalled();
});

test("node transport pins lookup, preserves TLS hostname/Host, disables pooling and bounds bytes", async () => {
    for (const oversized of [false, true]) {
        const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
        request.destroy = error => { request.emit("error", error); };
        const send: Parameters<typeof requestPinned>[3] = ((url: URL, options: any, callback: (response: unknown) => void) => {
            expect(url.hostname).toBe("docs.example"); expect(options.headers.Host).toBe("docs.example");
            expect(options.hostname).toBe("8.8.8.8"); expect(options.servername).toBe("docs.example");
            expect(options.checkServerIdentity("8.8.8.8", { subject: { CN: "attacker.example" }, subjectaltname: "DNS:attacker.example" })).toBeInstanceOf(Error);
            expect(options.agent).toBe(false); expect(options.rejectUnauthorized).not.toBe(false);
            options.lookup("docs.example", {}, (error: unknown, address: unknown, family: unknown) => { expect(error).toBeNull(); expect(address).toBe("8.8.8.8"); expect(family).toBe(4); });
            options.lookup("docs.example", { all: true }, (error: unknown, addresses: unknown) => { expect(error).toBeNull(); expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]); });
            request.end = () => {
                const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "text/plain" } });
                callback(response);
                response.emit("data", Buffer.alloc(oversized ? 5 * 1024 * 1024 + 1 : 10)); response.emit("end");
            };
            return request;
        }) as never;
        const work = requestPinned(new URL("https://docs.example"), { address: "8.8.8.8", family: 4 }, new AbortController().signal, send);
        if (oversized) await expect(work).rejects.toThrow("OUTPUT_LIMIT_REACHED");
        else expect((await (await work).arrayBuffer()).byteLength).toBe(10);
    }
});

test("real Bun HTTP transport connects to the pinned socket without resolving the URL hostname", async () => {
    let reached = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { reached++; return new Response(request.headers.get("host")); } });
    try {
        // Só o transporte recebe loopback neste teste; a tool o recusa antes de conectar.
        const response = await requestPinned(new URL(`http://unresolvable.invalid:${server.port}/fixture`), { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(2000));
        expect(await response.text()).toBe(`unresolvable.invalid:${server.port}`);
        expect(reached).toBe(1);
    } finally { await server.stop(true); }
});
