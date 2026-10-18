import { ResumePanel } from "../components/resume-panel";
import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import prettyMs from "pretty-ms";
import { MessageStatus } from "@myagent/database/enums";
import { messagePartsSchema, type SupportedChatModelId } from "@myagent/shared";
import type { InferResponseType } from "hono";
import { ApprovalPanel } from "../components/approval-panel";
import { SessionShell } from "../components/session-shell";
import { UserrMessage, BotMessage, ErrorMessage } from "../components/messages";
import { useToast } from "../providers/toast";
import { appClient } from "../lib/api-client";
import { useChat, clientMessageParts } from "../hooks/use-chat";
import type { Message, ClientMessagePart } from "../hooks/use-chat";
import { getErrorMessage } from "../lib/http-errors";
import { useKeyboard } from "@opentui/react";
import { PromptConfigProvider, usePromptConfig } from "../providers/prompt-config";
import { useKeyboardLayer } from "../providers/keyboard-layer";

type SessionData = InferResponseType<(typeof appClient.session)[":id"]["$get"], 200>;

const sessionLocationSchema = z.object({
    session: z.custom<SessionData>((value) => value != null && typeof value === "object" && "id" in value)
});

function mapDbMessages(dbMessages: SessionData["messages"]): Message[] {
    return dbMessages.map((message): Message => {
        if (message.role === "ERROR") {
            return { id: message.id, role: "error", content: message.content, totalTokens: message.totalTokens ?? undefined };
        }

        if (message.role === "USER") {
            return {
                id: message.id,
                role: "user",
                content: message.content,
                mode: message.mode,
                model: message.model as SupportedChatModelId
            };
        }

        const parsedParts = message.parts == null ? null : messagePartsSchema.safeParse(message.parts);
        const parts: ClientMessagePart[] = parsedParts?.success ? clientMessageParts(parsedParts.data) : [];

        return {
            id: message.id,
            role: "assistant",
            content: message.content,
            model: message.model as SupportedChatModelId,
            mode: message.mode,
            parts,
            totalTokens: message.totalTokens ?? undefined,
            ...(message.duration != null ? { duration: prettyMs(message.duration * 1000) } : {}),
            interrupted: message.status !== MessageStatus.COMPLETE
        };
    });
}

function ChatMessage({ msg }: { msg: Message }) {
    if (msg.role === "user") {
        return <UserrMessage message={msg.content} mode={msg.mode} />;
    }
    if (msg.role === "error") {
        return <ErrorMessage message={msg.content} />;
    }
    return (
        <BotMessage
            parts={msg.parts}
            model={msg.model}
            mode={msg.mode}
            duration={msg.duration}
            streaming={false}
            interrupted={msg.interrupted}
        />
    );
}

function SessionChat({ session }: { session: SessionData }) {
    const [initialMessages] = useState(() => mapDbMessages(session.messages));
    const { messages, streaming, submit, abort, interrupt, pendingApprovals, decideApproval, totalTokens, undoing, pendingResume, confirmResume, dismissResume } = useChat(session.id, initialMessages);
    const { isTopLayer } = useKeyboardLayer();
    const { mode, model } = usePromptConfig();

    useEffect(() => () => abort(), [abort]);

    useKeyboard((key) => {
        if (key.name === "escape" && isTopLayer("base") && streaming.status === "streaming") {
            key.preventDefault();
            interrupt();
        }
    });

    return (
        <SessionShell
            title={session.title}
            onSubmit={(text) => submit({ userText: text, mode, model })}
            loading={streaming.status === "streaming"}
            generationMode={streaming.status === "streaming" ? streaming.mode : undefined}
            interruptible={streaming.status === "streaming"}
            inputDisabled={pendingApprovals.length > 0 || undoing || !!pendingResume}
            totalTokens={totalTokens}
        >
            {messages.map((msg) => <ChatMessage key={msg.id} msg={msg} />)}
            {streaming.status === "streaming" && streaming.parts.length > 0 && (
                <BotMessage parts={streaming.parts} model={streaming.model} mode={streaming.mode} streaming />
            )}
            {pendingResume && <ResumePanel confirm={confirmResume} dismiss={dismissResume} />}
            {pendingApprovals[0] && <ApprovalPanel key={pendingApprovals[0].approvalId} approval={pendingApprovals[0]} decide={decideApproval} interrupt={interrupt} />}
        </SessionShell>
    );
}

export function Session() {
    const { id } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const toast = useToast();

    const prefetched = useMemo(() => {
        const parsed = sessionLocationSchema.safeParse(location.state);
        return parsed.success ? parsed.data.session : null;
    }, [location.state]);

    const [session, setSession] = useState<SessionData | null>(prefetched);

    useEffect(() => {
        if (prefetched) return;
        setSession(null);
        if (!id) return;

        let ignore = false;
        const fetchSession = async () => {
            try {
                const res = await appClient.session[":id"].$get({ param: { id } });
                if (ignore) return;
                if (!res.ok) throw new Error(await getErrorMessage(res));
                setSession(await res.json());
            } catch (error) {
                if (ignore) return;
                toast.show({
                    variant: "error",
                    message: error instanceof Error ? error.message : "Failed to load session"
                });
                navigate("/", { replace: true });
            }
        };

        void fetchSession();
        return () => { ignore = true; };
    }, [id, prefetched, toast, navigate]);

    if (!session) return <SessionShell onSubmit={() => {}} inputDisabled />;
    const lastMessage = session.messages.findLast(message => message.role === "USER" || message.role === "ASSISTANT");
    return <PromptConfigProvider key={session.id} initialMode={lastMessage?.mode ?? "BUILD"}>
        <SessionChat session={session} />
    </PromptConfigProvider>;
}
