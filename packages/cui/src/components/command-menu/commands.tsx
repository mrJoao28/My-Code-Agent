import { ThemeDialogContent } from "../../dialogs";
import type { Command } from "./types";


export const COMMANDS:Command[]= [
    {
        name:"new",
        description:"Start a new conversation",
        value:"/new",
        action:(ctx)=>{
            ctx.toast.show({message:"Starting new conversation..." ,})
        }
    },
   {
        name:"logout",
        description:"Sign out of our account",
        value:"/logout",
        action:(ctx)=>{
            ctx.toast.show({message:"Starting new conversation..." ,})
        }
    },
    {
        name:"upgrade",
        description:"Buy more credits",
        value:"/upgrade",
        action:(ctx)=>{
            ctx.toast.show({message:"Starting new conversation..." ,})
        }
    },
    {
        name:"usage",
        description:"Open billing portal in your browser",
        value:"/usage",
        action:(ctx)=>{
            ctx.toast.show({message:"Starting new conversation..." ,})
        }
    },
    {
        name:"login",
        description:"Sign in with your browser",
        value:"/login",
        action:(ctx)=>{
            ctx.toast.show({message:"Starting new conversation..." ,})
        }
    },
    {
        name:"sessions",
        description:"Bowse pas sessions",
        value:"/sessions",
        action:(ctx)=>{
            ctx.toast.show({message:"Starting new conversation..." ,})
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
        description:"Select a AI model for generation",
        value:"/models",
        action:(ctx)=>{
            ctx.dialog.open({
                title:"Select Model",
                children:<text>Model selections coming soon...</text>
            })
        }
    },
    {
        name:"agents",
        description:"Switch agents",
        value:"/agents",
        action:(ctx)=>{
            ctx.dialog.open({
                title:"Select Mode",
                children:<text>Agent selection coming soon...</text>
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
    }
]
