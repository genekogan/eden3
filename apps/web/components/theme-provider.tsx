"use client";

/**
 * Theme state (system / light / dark) — hand-rolled, no next-themes.
 *
 * The FOUC guard in app/layout.tsx stamps html[data-theme] before first
 * paint from localStorage["eden3.theme"] (falling back to
 * prefers-color-scheme). This provider owns the same state after hydration:
 * persists the choice, follows OS changes while in "system", and keeps the
 * <meta name="theme-color"> in sync.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "eden3.theme";
const THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: "#0a0b0a",
  light: "#f5f7f5",
};

function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function readStored(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  // Keep the browser chrome color honest when the user overrides the OS.
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    meta.content = THEME_COLORS[resolved];
    meta.removeAttribute("media");
  }
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState>({
  preference: "system",
  resolved: "dark",
  setPreference: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("dark");

  // Adopt the pre-paint state after hydration.
  useEffect(() => {
    const stored = readStored();
    setPreferenceState(stored);
    setResolved(stored === "system" ? systemTheme() : stored);
  }, []);

  // Follow OS changes while in "system".
  useEffect(() => {
    if (preference !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      const next = systemTheme();
      setResolved(next);
      applyTheme(next);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode — in-memory only */
    }
    setResolved(next === "system" ? systemTheme() : next);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}

/** Compact three-way toggle (system / light / dark). */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="group"
      aria-label="Theme"
      className={`flex w-fit overflow-hidden rounded-lg border border-edge ${className ?? ""}`}
    >
      {(
        [
          ["system", "Auto"],
          ["light", "Light"],
          ["dark", "Dark"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={preference === value}
          onClick={() => setPreference(value)}
          className={`px-2.5 py-1 text-xs transition-colors ${
            preference === value
              ? "bg-accent/15 text-accent-soft"
              : "bg-raised text-muted hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
