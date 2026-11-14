"use client";
import { useSyncExternalStore } from "react";
import { IconBook, IconMonitor, IconMoon, IconSun } from "./icons";

export type ThemeChoice = "system" | "light" | "dark" | "sepia";
const ORDER: ThemeChoice[] = ["system", "light", "dark", "sepia"];
const LABEL: Record<ThemeChoice, string> = { system: "Auto", light: "Light", dark: "Dark", sepia: "Sepia" };

export function applyTheme(t: ThemeChoice) {
  try {
    localStorage.setItem("ra-theme", t);
  } catch {}
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  window.dispatchEvent(new Event("ra-theme"));
}

function subscribe(cb: () => void) {
  window.addEventListener("ra-theme", cb);
  return () => window.removeEventListener("ra-theme", cb);
}

export function readTheme(): ThemeChoice {
  try {
    return (localStorage.getItem("ra-theme") as ThemeChoice) || "system";
  } catch {
    return "system";
  }
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as ThemeChoice);
  return [theme, applyTheme];
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useTheme();
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  const Icon = theme === "light" ? IconSun : theme === "dark" ? IconMoon : theme === "sepia" ? IconBook : IconMonitor;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="btn btn-ghost !px-2.5 !py-1.5 text-muted hover:text-fg"
      title={`Theme: ${LABEL[theme]} (click for ${LABEL[next]})`}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}`}
    >
      <Icon size={16} />
      {!compact && <span className="text-xs">{LABEL[theme]}</span>}
    </button>
  );
}
