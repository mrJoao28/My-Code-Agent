import { useTheme } from "../providers/theme";
import { formatTokens, SESSION_TOKEN_SCALE } from "../lib/token-usage";

export function TokenUsageBar({ totalTokens }: { totalTokens: number }) {
    const { colors } = useTheme();
    const percentage = Math.min(100, Math.max(0, totalTokens / SESSION_TOKEN_SCALE * 100));

    return (
        <box flexDirection="row" width="100%" height={1} flexShrink={0} gap={1} paddingX={1}>
            <text fg={colors.primary}>Tokens</text>
            <box id="token-usage-track" flexGrow={1} minWidth={0} height={1} backgroundColor={colors.surface}>
                <box id="token-usage-fill" visible={percentage > 0} width={`${percentage}%`} height={1} backgroundColor={colors.primary} />
            </box>
            <text fg={colors.primary} flexShrink={0}>{formatTokens(totalTokens)}</text>
        </box>
    );
}
