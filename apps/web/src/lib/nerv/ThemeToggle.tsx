"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "nerv-theme";

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "dark" ? "dark" : "light";
}

/**
 * Theme toggle. Light is the default — see the inline bootstrap script
 * in `layout.tsx` that applies the persisted choice before paint to
 * avoid a flash of the wrong theme.
 */
export function ThemeToggle() {
  // Start as null so the SSR markup matches whatever the inline
  // bootstrap script sets, then sync on mount.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  function toggle() {
    const next: Theme = (theme ?? readTheme()) === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // private-mode / disabled storage — non-fatal, choice just won't persist.
    }
    setTheme(next);
  }

  // Use a stable label until hydrated so SSR/CSR match.
  const label = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="toggle theme"
      className="text-[10px] uppercase tracking-widest text-nerv-text/70 hover:text-nerv-amber focus:text-nerv-amber px-2 py-2 -my-2 font-mono"
    >
      {label}
    </button>
  );
}
