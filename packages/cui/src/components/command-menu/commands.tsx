import { SUPPORTED_CHAT_MODELS } from "@myagent/shared";
import { SessionsDialogContent, ThemeDialogContent,AgentsDialogContent , ModelDialogContent} from "../../dialogs";
import type { Command } from "./types";


export const COMMANDS:Command[]= [
    {
        name:"logout",
        description:"Sign out of your account",
        value:"/logout",
        action:(ctx)=>{
            ctx.toast.show({message:"Logout is not implemented yet." ,})
        }
    },
    {
        name:"upgrade",
        description:"Buy more credits",
        value:"/upgrade",
        action:(ctx)=>{
            ctx.toast.show({message:"Upgrade is not implemented yet." ,})
        }
    },
    {
        name:"usage",
        description:"Open billing portal in your browser",
        value:"/usage",
        action:(ctx)=>{
            ctx.toast.show({message:"Usage portal is not implemented yet." ,})
        }
    },
    {
        name:"login",
        description:"Sign in with your browser",
        value:"/login",
        action:(ctx)=>{
            ctx.toast.show({message:"Login is not implemented yet." ,})
        }
    },
    {
        name:"sessions",
        description:"Browse past sessions",
        value:"/sessions",
        action:(ctx)=>{
            ctx.dialog.open({
                title:"Sessions",
                children:<SessionsDialogContent/>
            })
        }
    },
    {
        name:"theme",
        description:"Change color theme",
        value:"/theme",
        action:(ctx)=>{
            ctx.dialog.open({
                title:"Select Theme",
                children:<ThemeDialogContent/>
            })
        }
    },
    {
        name:"models",
        description:"Select an AI model for generation",
        value:"/models",
        action:(ctx)=>{
            ctx.dialog.open({
                title:"Select Model",
                children:<ModelDialogContent models={SUPPORTED_CHAT_MODELS.map((model)=>model.id)}  onSelectModel={ctx.setModel}/>
            })
        }
    },
    {
        name:"agents",
        description:"Switch agents",
        value:"/agents",
        action:(ctx)=>{
            ctx.dialog.open({
                title:"Select agent",
                children:<AgentsDialogContent currentMode={ctx.mode} onSelectMode={ctx.setMode}/>
            })
        }
    },
    {
        name:"exit",
        description:"Quit the application",
        value:"/exit",
        action:(ctx)=>{
            ctx.exit();
        }
    },
    {
        name:"new",
        description:"Start a new conversation",
        value:"/new",
        action:(ctx)=>{
            ctx.navigate("/")
        }
    },
]
