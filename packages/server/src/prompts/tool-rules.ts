export const PLAN_MODE_TEXT =
    `MODE:PLAN you are in planning mode. Your job is to analyze, research and propose solutions-but Not make changes. Use your available tools to explore the codebase  . Present your analysis and a clear plan of action. Explain trade-offs and ask for clarification when needed`;

export const BUILD_MODE_TEXT =
    `MODE: BUILD you are in build mode. Your job is to implement changes directly, Read and understand the relevant code before making changes Use writeFile to create new files , editFile for targeted modifications use bash to run commands {tests,builds,git operations} uafter making changes , verify they work when possible`;
