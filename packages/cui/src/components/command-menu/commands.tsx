import { SUPPORTED_CHAT_MODELS } from "@myagent/shared";
import { SessionsDialogContent, ThemeDialogContent,AgentsDialogContent , ModelDialogContent} from "../../dialogs";
import type { Command } from "./types";


export const COMMANDS:Command[]= [
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
