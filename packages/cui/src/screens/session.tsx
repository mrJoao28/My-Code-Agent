import { useEffect, useState, useMemo } from "react";
import { useParams, useLocation, useNavigate } from "react-router";
import { useTheme } from "../providers/theme";
import { SessionShell } from "../components/session-shell";
import { z } from "zod";
import prettyMs from "pretty-ms";
import { messagePartsSchema, type SupportedChatModelId } from "@myagent/shared";
import type { InferResponseType } from "hono";
import { UserrMessage, BotMessage, ErrorMessage } from "../components/messages";
import { useToast } from "../providers/toast";
import { appClient } from "../lib/api-client";
import { useChat } from "../hooks/use-chat";
import type { Message, ClientMessagePart } from "../hooks/use-chat";
import { getErrorMessage } from "../lib/http-errors";
import { useKeyboard } from "@opentui/react";
import { usePromptConfig } from "../providers/prompt-config";
import { MessageStatus } from "../../../database/generated/prisma/enums";
import { useKeyboardLayer } from "../providers/keyboard-layer";

type SessionData = InferResponseType<(typeof appClient.session)[":id"]["$get"], 200>;

const sessionLocationSchema = z.object({
    session: z.custom<SessionData>((val) => val != null && typeof val === "object" && "id" in val)
});

function mapDbMessages(dbMessages: SessionData["messages"]): Message[] {
    return dbMessages.map((m): Message => {
        if (m.role === "ERROR") {
            return { id: m.id, role: "error", content: m.content };
        }

        if (m.role === "USER") {
            return {
                id: m.id,
                role: "user",
                content: m.content,
                mode: m.mode,
                model: m.model as SupportedChatModelId
            };
        }

        const parsedParts = m.parts == null ? null : messagePartsSchema.safeParse(m.parts);

        const parts: ClientMessagePart[] = parsedParts?.success
            ? parsedParts.data.reduce<ClientMessagePart[]>((acc, p) => {
                  if (p.type === "tool-result") {
                      const tc = acc.find(
                          (x): x is Extract<ClientMessagePart, { type: "tool-call" }> =>
                              x.type === "tool-call" && x.id === p.id
                      );
                      if (tc) {
                          tc.result = p.result;
                      }
                      return acc;
                  }

                  if (p.type === "tool-call") {
                      acc.push({ ...p, status: "done" as const });
                      return acc;
                  }

                  acc.push(p);
                  return acc;
              }, [])
            : [];

        return {
            id: m.id,
            role: "assistant",
            content: m.content,
            model: m.model as SupportedChatModelId,
            mode: m.mode,
            parts,
            ...(m.duration != null ? { duration: prettyMs(m.duration * 1000) } : {}),
            interrupted: m.status === MessageStatus.INTERRUPTED
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
    const { messages, streaming, submit, abort, interrupt } = useChat(session.id, initialMessages);
    const { isTopLayer } = useKeyboardLayer();
    const { mode, model } = usePromptConfig();

    useEffect(() => {
        return () => abort();
    }, [abort]);

    useKeyboard((key) => {
        if (key.name === "escape" && isTopLayer("base") && streaming.status === "streaming") {
            key.preventDefault();
            interrupt();
        }
    });

    return (
        <SessionShell
            onSubmit={(text) => submit({ userText: text, mode, model })}
            loading={streaming.status === "streaming"}
            interruptible={streaming.status === "streaming"}
        >
            {messages.map((msg) => (
                <ChatMessage key={msg.id} msg={msg} />
            ))}
            {streaming.status === "streaming" && streaming.parts.length > 0 && (
                <BotMessage parts={streaming.parts} model={streaming.model} mode={streaming.mode} streaming />
            )}
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
                const res = await appClient.session[":id"].$get({
                    param: { id: id }
                });
                if (ignore) return;

                if (!res.ok) throw new Error(await getErrorMessage(res));
                setSession(await res.json());
            } catch (e) {
                if (ignore) return;

                toast.show({
                    variant: "error",
                    message: e instanceof Error ? e.message : "Failed to load session"
                });
                navigate("/", { replace: true });
            }
        };
        fetchSession();
        return () => {
            ignore = true;
        };
    }, [id, prefetched, toast, navigate]);

    if (!session) {
        return <SessionShell onSubmit={() => {}} inputDisabled />;
    }

    return <SessionChat key={session.id} session={session} />;
}