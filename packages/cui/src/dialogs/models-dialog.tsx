import { useCallback } from "react";
import { useDialog } from "../providers/dialog";
import { DialogSearchList } from "../components/dialog-search-list";
import{ Mode } from "../../../database/generated/prisma/enums";
import type { SupportedChatModelId } from "@myagent/shared";

const AVAILABLE_MODES:Mode[] = [Mode.BUILD,Mode.PLAN]

type ModelsDailogContentProps = {
    models:SupportedChatModelId[]
    onSelectModel:(mdelId:SupportedChatModelId)=>void
}


export const ModelDialogContent = ({models, onSelectModel}:ModelsDailogContentProps)=>{
    const dialog = useDialog()
    

    const handleSelect = useCallback(
        (modelId:SupportedChatModelId)=>{
            onSelectModel(modelId)
            dialog.close()
        },[onSelectModel,dialog]
    )

    return (
        <DialogSearchList  
        items={models}
        onSelect={handleSelect}
        filterFn={(modelId,query)=>modelId.toLocaleLowerCase().includes(query.toLocaleLowerCase())}
       renderItem={(modelId,isSelected)=>(
        <text selectable={false} fg={isSelected ? "black" : "white"}>
            {modelId}
        </text>
       )}
        getKey={(t)=>t}
        placeholder="Search models"
        emptyText="No matching models"
        />
    )
}