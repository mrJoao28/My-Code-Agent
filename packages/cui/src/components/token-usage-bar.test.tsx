import { expect, test } from "bun:test";
import { act } from "react";
import type { BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider, useTheme } from "../providers/theme";
import { TokenUsageBar } from "./token-usage-bar";
import { THEMES } from "../theme";

test.each([30, 90])("token bar renders empty, partial and overflow usage at width %s", async width => {
    let update!: (tokens: number) => void;
    const { useState } = await import("react");
    function Harness() {
        const [tokens, setTokens] = useState(0);
        update = setTokens;
        return <ThemeProvider><TokenUsageBar totalTokens={tokens} /></ThemeProvider>;
    }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => { ui = await testRender(<Harness />, { width, height: 3 }); });
    try {
        await ui.waitForFrame(frame => frame.includes("Tokens") && frame.includes("0"));
        const track = ui.renderer.root.findDescendantById("token-usage-track")!;
        const fill = ui.renderer.root.findDescendantById("token-usage-fill")!;
        expect(fill.visible).toBe(false);
        await act(async () => { update(500_000); });
        await ui.waitForFrame(frame => frame.includes("500k"));
        expect(Math.abs(fill.width - track.width / 2)).toBeLessThanOrEqual(1);
        await act(async () => { update(2_500_000); });
        await ui.waitForFrame(frame => frame.includes("2.5M"));
        expect(fill.width).toBe(track.width);
    } finally { await act(async () => { ui.renderer.destroy(); }); }
});

test.each(THEMES)("bar uses the active palette for $name", async theme => {
    let palette!: ReturnType<typeof useTheme>["colors"];
    function Harness() {
        palette = useTheme().colors;
        return <TokenUsageBar totalTokens={500_000} />;
    }
    let ui!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => { ui = await testRender(<ThemeProvider initialTheme={theme}><Harness /></ThemeProvider>, { width: 60, height: 3 }); });
    try {
        await ui.waitForFrame(frame => frame.includes("500k"));
        const { RGBA } = await import("@opentui/core");
        const fill = ui.renderer.root.findDescendantById("token-usage-fill") as BoxRenderable;
        const track = ui.renderer.root.findDescendantById("token-usage-track") as BoxRenderable;
        expect(fill.backgroundColor).toEqual(RGBA.fromHex(palette.primary));
        expect(track.backgroundColor).toEqual(RGBA.fromHex(palette.surface));
    } finally { await act(async () => { ui.renderer.destroy(); }); }
});
