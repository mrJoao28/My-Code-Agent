import { useEffect , useState,useMemo} from "react";
import { useParams,useLocation,useNavigate } from "react-router";
import { useTheme } from "../providers/theme";
import { SessionShell } from "../components/session-shell";
import {z} from "zod"
import type { InferResponseType } from "hono";
import { UserrMessage , BotMessage,ErrorMessage } from "../components/messages";
import { useToast } from "../providers/toast";
import { appCLient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import { ms } from "zod/locales";

type SessionData = InferResponseType<(typeof appCLient.session)[":id"]["$get"],200>

const sessionLocationSchema = z.object({
    session:z.custom<SessionData>((val)=>val!=null && typeof val === "object" && "id" in val)
})
function ChatMessage(
    {msg}:{
        msg:SessionData["messages"][number]
    }
){
    if (msg.role==="USER"){
        return <UserrMessage  message={msg.content}/>
    }
    if (msg.role==="ERROR"){
        return <ErrorMessage  message={msg.content}/>
    }
    return <BotMessage content={msg.content} model={msg.model}/>
}

export function Session(){
    const {id} = useParams()
    const location = useLocation()
    const navigate = useNavigate()
    const toast = useToast()

    const prefetched = useMemo(()=>{
        const parsed = sessionLocationSchema.safeParse(location.state);
        return parsed.success?parsed.data.session:null
    },[location.state])

    const [session,setSession] =useState<SessionData|null>(prefetched)

    useEffect(()=>{
        if (prefetched) return

        setSession(null)
        if(!id) return 

        let ignore = false
        const fetchSession = async ()=>{
            try{
                const res = await appCLient.session[":id"].$get({
                    param:{id:id}
                })
                if (ignore) return

                if (!res.ok) throw new Error(await getErrorMessage(res))
                setSession(await res.json())
            }catch (e){
                if (ignore) return

                toast.show({
                    variant:"error",
                    message:e instanceof Error ? e.message:"Failed to load session",
                })
                navigate("/",{replace:true})
            }
        }
        fetchSession()
        return ()=>{
            ignore=true
        }
    },[id,prefetched,toast,navigate])


    if (!session){
        return <SessionShell onSubmit={()=>{}} inputDisabled />
    }

    return (
        <SessionShell onSubmit={()=>{}} inputDisabled >
            {session.messages.map((msg)=>(
                <ChatMessage key={msg.id} msg={msg}/>
            ))}
        </SessionShell>
    )
}
