import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import type { ThemeColors, Theme } from "../../theme";
import { THEMES, DEFAULT_THEME } from "../../theme";

const CONFIG_DIR = join(homedir(), ".myAgent");
const THEME_PREFERENCES_PATH = join(CONFIG_DIR, "preferences.json");

type ThemePreferences = {
    themeName: string;
};

function getInitialTheme(): Theme {
    try {
        const preferences = JSON.parse(
            readFileSync(THEME_PREFERENCES_PATH, "utf8"),
        ) as Partial<ThemePreferences>;

        const savedTheme = THEMES.find(
            (theme) => theme.name === preferences.themeName,
        );

        return savedTheme ?? DEFAULT_THEME;
    } catch {
        return DEFAULT_THEME;
    }
}

function persistTheme(theme: Theme) {
    try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            THEME_PREFERENCES_PATH,
            JSON.stringify({ themeName: theme.name } satisfies ThemePreferences, null, 2),
            "utf8",
        );
    } catch {
        // Theme persistence must not prevent the UI from working.
    }
}

type ThemeContextValue = {
    colors: ThemeColors;
    currentTheme: Theme;
    setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
    const value = useContext(ThemeContext);
    if (!value) {
        throw new Error("useTheme must be used within a ThemeProvider");
    }
    return value;
}

type ThemeProviderProps = {
    children: ReactNode;
};

export function ThemeProvider({ children }: ThemeProviderProps) {
    const [currentTheme, setCurrentTheme] = useState<Theme>(getInitialTheme);

    const setTheme = useCallback((theme: Theme) => {
        setCurrentTheme(theme);
        persistTheme(theme);
    }, []);

    return (
        <ThemeContext.Provider
            value={{ colors: currentTheme.colors, currentTheme, setTheme }}
        >
            {children}
        </ThemeContext.Provider>
    );
}
