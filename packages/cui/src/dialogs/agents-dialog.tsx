import { useCallback } from "react";
import { useDialog } from "../providers/dialog";
import { DialogSearchList } from "../components/dialog-search-list";
import{ Mode } from "../../../database/generated/prisma/enums";

const AVAILABLE_MODES:Mode[] = [Mode.BUILD,Mode.PLAN]

type AgentsDialogContentProps = {
    currentMode:Mode
    onSelectMode:(mode:Mode)=>void
}

function getModeLabel(mode:Mode){
    return mode===Mode.PLAN ? "Plan":"Build"
}


export const AgentsDialogContent = ({currentMode, onSelectMode}:AgentsDialogContentProps)=>{
    const dialog = useDialog()
    

    const handleSelect = useCallback(
        (nextMode:Mode)=>{
            onSelectMode(nextMode)
            dialog.close()
        },[onSelectMode,dialog]
    )

    return (
        <DialogSearchList  
        items={AVAILABLE_MODES}
        onSelect={handleSelect}
        filterFn={(item,query)=>getModeLabel(item).toLocaleLowerCase().includes(query.toLocaleLowerCase())}
       renderItem={(item,isSelected)=>(
        <text selectable={false} fg={isSelected ? "black" : "white"}>
            {item===currentMode?"🟡": "   "}
        </text>
       )}
        getKey={(t)=>t}
        placeholder="Search modes"
        emptyText="No matching modes"
        />
    )
}