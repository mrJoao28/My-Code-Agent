import { useEffect ,useMemo,useRef} from "react";
import { useNavigate, useLocation, replace } from "react-router";
import { useTheme } from "../providers/theme";
import { SessionShell } from "../components/session-shell";
import { ErrorMessage, UserrMessage,BotMessage } from "../components/messages";
import {z} from"zod"
import { DEFAULT_CHAT_MODEL_ID } from "@myagent/shared";
import { useToast } from "../providers/toast";
import { appCLient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";

const newSessionStateSchema = z.object({
    message:z.string()
})

export function NewSession(){
    const navigate = useNavigate()
    const location = useLocation()
    const {colors} = useTheme()
    const toast = useToast()
    const hasStartedRef = useRef(false)

    const state =useMemo(()=>{
        const parsed = newSessionStateSchema.safeParse(location.state)
        return parsed.success?parsed.data:null
    },[location.state])



useEffect(()=>{
    if (!state){
        navigate("/",{replace:true})
    }
},[state,navigate])

useEffect(()=>{
    if (!state || hasStartedRef.current) return
    hasStartedRef.current = true;

    let ignore = false
    const createSession = async ()=>{
        try{
            const res = await appCLient.session.$post({
                json:{
                    title:state.message.slice(0,100),
                    cwd:process.cwd(),
                    initialMessage:{
                        role:"USER",
                        content:state.message,
                        mode:"BUILD",
                        model:DEFAULT_CHAT_MODEL_ID
                    }
                }
            })

            if (ignore) return
            if (!res.ok){
                throw new Error(await getErrorMessage(res))
            }
            const session = await res.json()
            navigate(`/sessions/${session.id}`,{replace:true,state:{session}})
        } catch (e){
            if (ignore) return 
            toast.show({
                variant:"error",
                message:e instanceof Error ? e.message:"Failed to create a session"
            })
            navigate("/",{replace:true})
        }
    }

    createSession();
    return ()=>{
        ignore = true
    }
},[state,navigate,toast])

    if (!state) return null

    return (
        <SessionShell onSubmit={()=>{}} inputDisabled loading>
            <UserrMessage message={state.message}/>
        </SessionShell>
    )
}
