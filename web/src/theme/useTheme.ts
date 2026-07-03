import { useCallback, useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
const COOKIE = "yeti_theme";

function readCookie(): Theme {
  const m = document.cookie.match(/(?:^|;\s*)yeti_theme=(system|light|dark)/);
  return (m?.[1] as Theme) ?? "system";
}

function apply(theme: Theme) {
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.removeAttribute("data-theme");
  if (theme === "dark") el.classList.add("dark");
  else if (theme === "light") el.classList.add("light");
  // system → no class; CSS prefers-color-scheme takes over.
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => readCookie());

  useEffect(() => { apply(theme); }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    document.cookie = `${COOKIE}=${next}; Path=/; SameSite=Strict; Max-Age=31536000`;
    setThemeState(next);
  }, []);

  const cycle = useCallback(() => {
    setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system");
  }, [theme, setTheme]);

  return { theme, setTheme, cycle };
}
