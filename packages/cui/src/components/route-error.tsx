import { useKeyboard, useRenderer } from "@opentui/react";
import { useRouteError } from "react-router";

// O fallback padrão do React Router usa elementos DOM (h2/pre), incompatíveis com OpenTUI.
export function RouteError() {
    const error = useRouteError();
    const renderer = useRenderer();
    useKeyboard(key => {
        if (key.ctrl && key.name === "c") renderer.destroy();
    });
    return <box flexDirection="column" padding={2} gap={1}>
        <text fg="red">Não foi possível renderizar a tela.</text>
        <text>{error instanceof Error ? error.message : "Falha inesperada na navegação."}</text>
        <text>Ctrl+C para sair</text>
    </box>;
}
