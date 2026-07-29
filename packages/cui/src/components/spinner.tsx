import "opentui-spinner/react"
import { useTheme } from "../providers/theme"
import { Mode } from "../../../database/generated/prisma/enums"

type Props = {
    mode?:Mode
}

export function Spinner({mode=Mode.BUILD}:Props){
    const {colors} = useTheme()
    const activeColor = mode === Mode.PLAN ? colors.planMode : colors.primary


    return <spinner name="aesthetic" color={activeColor}/>
} 

