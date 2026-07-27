import type {RefObject} from "react"
import { TextAttributes , type ScrollBoxRenderable } from "@opentui/core"
import { getFilteredCommands } from "./filter-commands"
import { COMMANDS } from "./commands"

const MAX_VARIABLE_ITEMS = 9;

const COMMAND_COL_WIDTH = Math.max(...COMMANDS.map((cmd)=>cmd.name.length)) +4

type CommandMenuProps = {
    query:string;
    selectedIndex:number;
    scrollRef:RefObject<ScrollBoxRenderable |null>;
    onSelect:(index:number)=>void;
    onExecute:(index:number)=>void;
}


export function CommandMenu({
    query,
    selectedIndex,
    scrollRef,
    onSelect,
    onExecute
}:CommandMenuProps){
    const filtered = getFilteredCommands(query);
    const visibleHeight = Math.min(filtered.length,MAX_VARIABLE_ITEMS)

    if (filtered.length===0){
        return (
            <box paddingX={1}>
                <text attributes={TextAttributes.DIM}>
                    Nothing matching commands
                </text>
            </box>
        )
    }

    return (
        <scrollbox ref={scrollRef} height={visibleHeight}>
            {filtered.map((cmd,i)=>{
                const isSelected = i===selectedIndex

                return (
                    <box   
                    key={cmd.value}
                    flexDirection="row"
                    paddingX={1}
                    height={1}
                    backgroundColor={isSelected?"#89B4FA":undefined}
                    onMouseMove={()=>onSelect(i)}
                    onMouseDown={()=>onExecute(i)}
                    >
                        <box width={COMMAND_COL_WIDTH} flexGrow={0}>
                            <text selectable={false} fg={isSelected?"black":"white"}>
                                /{cmd.name}
                            </text>
                        </box>
                        <box flexGrow={1} flexShrink={1} overflow="hidden">
                            <text selectable={false} fg={isSelected?"balck":"gray"}>
                                {cmd.description}
                            </text>
                            </box>
                    </box>
                )
            })}
        </scrollbox>
        
    )
}