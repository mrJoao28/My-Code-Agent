import { useEffect } from "react";
import { useNavigate, useLocation, replace } from "react-router";
import { useTheme } from "../providers/theme";
import { SessionShell } from "../components/session-shell";
import { ErrorMessage, UserrMessage,BotMessage } from "../components/messages";


export function NewSession(){
    const navigate = useNavigate()
    const location = useLocation()
    const {colors} = useTheme()

    const state = location.state as {message?:string}|null

useEffect(()=>{
    if (!state?.message){
        navigate("/",{replace:true})
    }
},[state,navigate])

    if (!state?.message) return null

    return (
        <SessionShell onSubmit={()=>{}} inputDisabled loading>
            <UserrMessage message={state.message}/>
            <BotMessage content="This is a sample bot response" model="mythos 5"/>
            <ErrorMessage message="This is a sample of a error message"/>
        </SessionShell>
    )
}
