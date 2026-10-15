import { expect, test } from "bun:test";
import { formatTokens, sumSessionTokens } from "./token-usage";

test.each([
    [0, "0"], [999, "999"], [1_000, "1k"], [1_250, "1.3k"],
    [999_949, "999.9k"], [999_950, "1M"], [1_000_000, "1M"], [2_500_000, "2.5M"],
] as const)("formats %s tokens as %s", (value, label) => {
    expect(formatTokens(value)).toBe(label);
});

test("session usage includes persisted failures and interruptions and accepts legacy messages", () => {
    expect(sumSessionTokens([{}, { totalTokens: null }, { totalTokens: 1_200 }, { totalTokens: 300 }])).toBe(1_500);
    expect(sumSessionTokens([])).toBe(0);
});
