import type { ReactNode } from "react";
import { useTheme } from "../providers/theme";

type Props = {
children:ReactNode
}

export function ThemeRoot({children}:Props){
  const {colors} = useTheme();
  return(
    <box   
    backgroundColor={colors.backgorund}
    width={"100%"}
    height={"100%"}
    flexGrow={1}
    >
        {children}
    </box>
  )
}