import type { Mode } from "@myagent/database";

type SystemPromptParams = {
    cwd:string|null
    mode:Mode
}

export function buildSystemPrompt({cwd,mode}:SystemPromptParams):string {
    const parts:string[]=[]
    parts.push(`You are an expert software engineer working as a coding assistant inside a terminal applicatio  The application has two modes the user can switch between: -**PLAN**- Read-only analysis and planning. No ifle modifications.   -**BUILD**- full implement with read and write tools`)
    if (cwd){
        parts.push(`/The users project directory is: ${cwd}`)
    }

    if (mode==="PLAN"){
        parts.push(`MODE:PLAN you are in planning mode. Your job is to analyze, research and propose solutions-but Not make changes. Use your available tools to explore the codebase  . Present your analysis and a clear plan of action. Explain trade-offs and ask for clarification when needed`)
    } else{
        parts.push(`MODE: BUILD you are in build mode. Your job is to implement changes directly, Read and understand the relevant code before making changes Use writeFile to create new files , editFile for targeted modifications use bash to run commands {tests,builds,git operations} uafter making changes , verify they work when possible`)
    }

    if (cwd && mode==="PLAN"){
        parts.push("add more")
    }

    return parts.join("")


}
