import { test, expect, spyOn } from "bun:test";
import { createWebFetchTool } from "./web-fetch";

test("session domain permission cannot follow a redirect to another origin", async () => {
    const fetch = stubFetch(async () => new Response(null, { status: 302, headers: { Location: "https://93.184.216.35/other" } }));
    try {
        await expect(execute(createWebFetchTool(true), { url: "https://93.184.216.34/start" })).rejects.toThrow("aprovar esse domínio");
        expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
});
import { createWebSearchTool } from "./web-search";
import { execute } from "../test-support";
function stubFetch(fn: () => Promise<Response>) {
    return spyOn(globalThis, "fetch").mockImplementation(Object.assign(fn, { preconnect: () => {} }));
}

test("web_fetch strips active HTML, decodes entities and bounds returned text", async () => {
    const fetch = stubFetch(async () => new Response("<script>private()</script><p>Hello &amp; world</p>" + "x".repeat(12_000), { headers: { "Content-Type": "text/html" } }));
    try {
        const result = await execute(createWebFetchTool(), { url: "https://93.184.216.34/documentation" });
        expect(result.content).toStartWith("Hello & world");
        expect(result.content).not.toContain("private()");
        expect(result.content).toHaveLength(10_000); expect(result.truncated).toBe(true);
    } finally { fetch.mockRestore(); }
});

test("web_fetch abort interrupts a pending response body and cancels it", async () => {
    let cancelled = false;
    const fetch = stubFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    const controller = new AbortController();
    try {
        const work = execute(createWebFetchTool(), { url: "https://93.184.216.34/stream" }, controller.signal);
        await Bun.sleep(1);
        controller.abort(new Error("fixture cancelled"));
        await expect(work).rejects.toThrow("fixture cancelled");
        expect(cancelled).toBe(true);
    } finally { fetch.mockRestore(); }
});

test("web_search validates provider output, bounds bytes and honors cancellation", async () => {
    const previous = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "fixture-key";
    let cancelled = false;
    const fetch = stubFetch(async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel() { cancelled = true; },
    })));
    try {
        await expect(execute(createWebSearchTool(), { query: "test" })).rejects.toThrow("OUTPUT_LIMIT_REACHED");
        expect(cancelled).toBe(true);
        const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
        const calls = fetch.mock.calls.length;
        await expect(execute(createWebSearchTool(), { query: "test" }, controller.signal)).rejects.toThrow("fixture cancelled");
        expect(fetch.mock.calls.length).toBe(calls);
        fetch.mockImplementation(Object.assign(async () => Response.json({ results: "invalid" }), { preconnect: () => {} }));
        await expect(execute(createWebSearchTool(), { query: "test" })).rejects.toThrow();
    } finally {
        fetch.mockRestore();
        if (previous === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previous;
    }
});
test("web_fetch blocks internal targets and redirects before issuing the internal request", async () => {
    const fetch = stubFetch(async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }));
    try {
        await expect(execute(createWebFetchTool(), { url: "http://127.0.0.1/private" })).rejects.toThrow();
        await expect(execute(createWebFetchTool(), { url: "http://169.254.169.254/metadata" })).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(0);
        await expect(execute(createWebFetchTool(), { url: "https://93.184.216.34/redirect" })).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
});
test("web_search requires a key and returns bounded structured snippets without real network", async () => {
    const previous = process.env.TAVILY_API_KEY;
    const fetch = stubFetch(async () => Response.json({ answer: "answer", results: [{ title: "title", url: "https://example.invalid", content: "x".repeat(700) }] }));
    try {
        delete process.env.TAVILY_API_KEY;
        await expect(execute(createWebSearchTool(), { query: "test" })).rejects.toThrow("TAVILY_API_KEY");
        expect(fetch).toHaveBeenCalledTimes(0);
        process.env.TAVILY_API_KEY = "fixture-not-a-real-key";
        const result = await execute(createWebSearchTool(), { query: "test" });
        expect(result.answer).toBe("answer"); expect(result.results[0]!.snippet).toHaveLength(500);
    } finally {
        fetch.mockRestore();
        if (previous === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previous;
    }
});
