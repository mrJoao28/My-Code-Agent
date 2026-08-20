import { useCallback, useEffect, useRef } from "react";
import { useDialog } from "../providers/dialog";
import { useDialogSearchList } from "../components/dialog-search-list";
import { useTheme } from "../providers/theme";
import { DialogSearchList } from "../components/dialog-search-list";
import { THEMES } from "../theme";
import type { Theme } from "../theme";

export const ThemeDialogContent = () => {
    const dialog = useDialog();
    const { setTheme, currentTheme } = useTheme();
    const originalThemeRef = useRef(currentTheme);
    const confirmedRef = useRef(false);

    useEffect(() => {
        return () => {
            if (!confirmedRef.current) {
                setTheme(originalThemeRef.current);
            }
        };
    }, [setTheme]);

    const handleSelect = useCallback(
        (theme: Theme) => {
            confirmedRef.current = true;
            setTheme(theme);
            dialog.close();
        },
        [setTheme, dialog],
    );

    const handleHighlight = useCallback(
        (theme: Theme) => {
            setTheme(theme);
        },
        [setTheme],
    );

    return (
        <DialogSearchList
            items={THEMES}
            onSelect={handleSelect}
            onHighlight={handleHighlight}
            filterFn={(theme, query) =>
                theme.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
            }
            renderItem={(theme, isSelected) => (
                <text
                    selectable={false}
                    fg={isSelected ? "#ffffff" : undefined}
                >
                    {theme.name === originalThemeRef.current.name ? " • " : "   "}
                    {theme.name}
                </text>
            )}
            getKey={(theme) => theme.name}
            placeholder="Search themes"
            emptyText="No matching themes"
        />
    );
};
