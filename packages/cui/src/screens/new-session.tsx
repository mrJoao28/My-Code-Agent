import { useEffect, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router";
import { z } from "zod";
import { Mode } from "@myagent/database";
import type { SupportedChatModelId } from "@myagent/shared";
import { SessionShell } from "../components/session-shell";
import { UserrMessage } from "../components/messages";
import { useToast } from "../providers/toast";
import { appClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";

const newSessionStateSchema = z.object({
    message: z.string().trim().min(1),
    mode: z.enum(Mode),
    model: z.string().min(1) as z.ZodType<SupportedChatModelId>
});

export function NewSession() {
    const navigate = useNavigate();
    const location = useLocation();
    const toast = useToast();
    const hasStartedRef = useRef(false);

    const state = useMemo(() => {
        const parsed = newSessionStateSchema.safeParse(location.state);
        return parsed.success ? parsed.data : null;
    }, [location.state]);

    useEffect(() => {
        if (!state) {
            navigate("/", { replace: true });
        }
    }, [state, navigate]);

    useEffect(() => {
        if (!state || hasStartedRef.current) return;
        hasStartedRef.current = true;

        let ignore = false;

        const createSession = async () => {
            try {
                const res = await appClient.session.$post({
                    json: {
                        title: state.message.slice(0, 100),
                        cwd: process.cwd(),
                        initialMessage: {
                            role: "USER",
                            content: state.message,
                            mode: state.mode,
                            model: state.model
                        }
                    }
                });

                if (ignore) return;
                if (!res.ok) {
                    throw new Error(await getErrorMessage(res));
                }

                const session = await res.json();
                navigate(`/sessions/${session.id}`, { replace: true, state: { session } });
            } catch (error) {
                if (ignore) return;
                toast.show({
                    variant: "error",
                    message: error instanceof Error ? error.message : "Failed to create a session"
                });
                navigate("/", { replace: true });
            }
        };

        void createSession();
        return () => {
            ignore = true;
        };
    }, [state, navigate, toast]);

    if (!state) return null;

    return (
        <SessionShell onSubmit={() => {}} inputDisabled loading>
            <UserrMessage message={state.message} mode={state.mode} />
        </SessionShell>
    );
}
