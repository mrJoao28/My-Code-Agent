export const EmptyBorder = {
    topT:"",
    cross:"",
    leftT:"",
    rightT:"",
}

export const SplitBorder = {
    border:["left" as const , "right" as const],
    customBorderChars:{
        ...EmptyBorder,
        vertical:""
    }
}