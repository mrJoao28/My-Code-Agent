import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import type { Mode } from "@myagent/database/enums";
import { InputBar } from "./input-bar";
import { Spinner } from "./spinner";
import { TokenUsageBar } from "./token-usage-bar";
import { usePromptConfig } from "../providers/prompt-config";

type Props = {
    title?: string
    children?: ReactNode
    onSubmit: (text: string) => void
    inputDisabled?: boolean
    loading?: boolean
    interruptible?:boolean
    totalTokens?: number
    generationMode?: Mode
}

export function SessionShell({
    title,
    children,
    onSubmit,
    inputDisabled = false,
    loading = false,
    interruptible=false,
    totalTokens = 0,
    generationMode,
}: Props) {
    const {mode} = usePromptConfig()
    return (
        <box
            flexDirection="column"
            flexGrow={1}
            width={"100%"}
            height={"100%"}
            paddingY={1}
            paddingX={2}
            gap={1}
        >
            {title && <text>{title}</text>}
            <scrollbox flexGrow={1} width={"100%"} stickyScroll stickyStart="bottom">
                <box gap={1}>{children}</box>
            </scrollbox>
            <box flexShrink={0}>
                <InputBar onSubmit={onSubmit} disabled={inputDisabled} generating={loading} />
            </box>
            <TokenUsageBar totalTokens={totalTokens} />
            <box
                flexShrink={0}
                flexDirection="row"
                justifyContent="space-between"
                width={"100%"}
                height={1}
                gap={2}
                paddingLeft={1}
            >
                <box flexDirection="row" gap={2} alignItems="center">
                    {loading ? (
                        <>
                        <Spinner mode={generationMode ?? mode}/>
                        <text>Executando em {generationMode ?? mode}</text>
                        {interruptible?<text>esc to interrupt</text>:null}
                        </>
                    ):null}
                </box>

                <box flexDirection="row" gap={1} flexShrink={0} marginLeft={"auto"}>
                    <text>tab</text>
                    <text attributes={TextAttributes.DIM}>agents</text>
                </box>
            </box>
        </box>
    )
}
