import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "ocf-desktop-theme";

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readInitialMode(): ThemeMode {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export interface ThemeController {
  readonly mode: ThemeMode;
  readonly resolved: ResolvedTheme;
  setMode(mode: ThemeMode): void;
  toggle(): void;
}

export function useTheme(): ThemeController {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => {
    const initial = readInitialMode();
    return initial === "system" ? systemTheme() : initial;
  });

  useEffect(() => {
    const apply = () => {
      const next = mode === "system" ? systemTheme() : mode;
      setResolved(next);
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    };
    apply();
    window.localStorage.setItem(STORAGE_KEY, mode);
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return {
    mode,
    resolved,
    setMode,
    toggle: () => setMode(resolved === "dark" ? "light" : "dark"),
  };
}
