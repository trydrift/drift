"use client";

import { useEffect, useState } from "react";

/**
 * Light and dark, remembered.
 *
 * Kept in sync with the pre-paint script in `layout.tsx` — same storage key,
 * same class — and it updates `theme-color` too, so the browser chrome follows
 * the page instead of staying whatever the first paint decided.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("drift:theme", next ? "dark" : "light");
    } catch {
      // A private window with storage blocked still gets the toggle; it just
      // will not be remembered, which is a better outcome than a thrown error
      // taking the button with it.
    }
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next ? "#0a0b0a" : "#f6f7f4");
    // Anything painting outside the CSS variables — the backdrop shader takes
    // its colours as props — has no other way to learn the theme changed.
    window.dispatchEvent(new Event("themechange"));
  };

  return (
    <button
      onClick={toggle}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {dark ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4" aria-hidden>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      )}
    </button>
  );
}
