import { registerSpinner } from "opentui-spinner/react"
import { useTheme } from "../providers/theme"
import { Mode } from "@myagent/database/enums"

// O Bun elimina o import apenas por efeito colateral ao empacotar a CLI.
registerSpinner()

type Props = {
    mode?:Mode
}

export function Spinner({mode=Mode.BUILD}:Props){
    const {colors} = useTheme()
    const activeColor = mode === Mode.PLAN ? colors.planMode : colors.primary


    return <spinner name="aesthetic" color={activeColor}/>
} 

