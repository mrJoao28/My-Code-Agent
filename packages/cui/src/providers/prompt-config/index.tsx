import { createContext , useContext,useState , useCallback } from "react";
import type {ReactNode} from "react"
import { DEFAULT_CHAT_MODEL_ID, type SupportedChatModelId } from "@myagent/shared";
import { Mode } from "../../../../database/generated/prisma/enums";

type PromptConfigCOntextValue = {
    mode:Mode
    toggleMode:()=>void
    setMode:(mode:Mode)=>void
    model:SupportedChatModelId
    setModel:(model:SupportedChatModelId)=>void
}

const PromptConfigCOntext = createContext<PromptConfigCOntextValue |null>(null)

export function usePromptConfig():PromptConfigCOntextValue{
    const value = useContext(PromptConfigCOntext)

    if (!value){
        throw new Error("usePromptCOnfig must be used within a PromptConfigProvider")
    }

    return value
}

type PromptConfigProviderProps = {
    children:ReactNode
}

export function PromptConfigProvider({children}:PromptConfigProviderProps){
    const [mode,setMode] = useState<Mode>(Mode.BUILD)
    const [model , setModel] = useState<SupportedChatModelId>(DEFAULT_CHAT_MODEL_ID)

    const toggleMode = useCallback(()=>{
        setMode((m)=>(m===Mode.BUILD ? Mode.PLAN: Mode.BUILD))
    },[])

    return (
        <PromptConfigCOntext.Provider 
            value={{
                mode,
                toggleMode,
                setMode,
                model,setModel
            }}>
                {children}
            </PromptConfigCOntext.Provider>
    )
}