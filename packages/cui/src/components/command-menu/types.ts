import type { SupportedChatModelId } from "@myagent/shared";
import type { Mode } from "../../../../database/generated/prisma/enums";
import type { DialogContextValue } from "../../providers/dialog";
import type { ToastContextValue } from "../../providers/toast";

export type CommandContext = {
    exit:()=>void
    toast:ToastContextValue
    dialog:DialogContextValue
    navigate:(path:string)=>void
    mode:Mode
    setMode:(mode:Mode)=>void
    setModel:(model:SupportedChatModelId)=>void
}

export type Command={
    name:string;
    description:string;
    value:string;
    action?:(ctx:CommandContext)=>void|Promise<void>
}
