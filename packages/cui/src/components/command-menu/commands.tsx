import type { Command } from "./types";


export const COMMANDS:Command[]= [
    {
        name:"new",
        description:"Start a new conversation",
        value:"/new"
    },
   {
        name:"logout",
        description:"Sign out of our account",
        value:"/logout"
    },
    {
        name:"upgrade",
        description:"Buy more credits",
        value:"/upgrade"
    },
    {
        name:"usage",
        description:"Open billing portal in your browser",
        value:"/usage"
    },
    {
        name:"login",
        description:"Sign in with your browser",
        value:"/login"
    },
    {
        name:"sessions",
        description:"Bowse pas sessions",
        value:"/sessions"
    },
    {
        name:"them",
        description:"Change color theme",
        value:"/theme"
    },
    {
        name:"models",
        description:"Select a AI model for generation",
        value:"/models"
    },
    {
        name:"agents",
        description:"Switch agents",
        value:"/agents"
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
