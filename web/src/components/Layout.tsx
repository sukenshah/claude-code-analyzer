import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { AppLogo } from "./AppLogo.js";
import { ConfigBanner } from "./ConfigBanner.js";

function getStoredTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return (document.documentElement.dataset.theme as "light" | "dark") || "light";
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="8" strokeWidth="3" strokeLinecap="round" />
      <line x1="12" y1="12" x2="12" y2="16" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(getStoredTheme);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("claude-theme", next);
    setTheme(next);
  }

  return (
    <button className="btn-theme" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [configuredAt, setConfiguredAt] = useState(0);
  const handleConfigured = useCallback(() => setConfiguredAt(Date.now()), []);

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link to="/" className="nav-brand">
            <AppLogo height={22} />
          </Link>
          <div className="nav-right">
            <div id="nav-actions" />
            <Link to="/info" className="btn-theme" aria-label="About / README">
              <InfoIcon />
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </nav>
      <ConfigBanner key={configuredAt} onConfigured={handleConfigured} />
      {children}
    </>
  );
}
