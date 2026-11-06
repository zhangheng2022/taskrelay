import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
export function useTheme(active = true) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("taskrelay.theme");
      return saved === "dark" || saved === "light" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    if (!active) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("taskrelay.theme", theme);
    } catch {}
    return () => media.removeEventListener("change", apply);
  }, [active, theme]);
  return [theme, setTheme] as const;
}
