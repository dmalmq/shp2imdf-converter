import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useAppStore } from "../../store/useAppStore";
import { StepIndicator } from "./StepIndicator";


type Props = {
  children: React.ReactNode;
};


export function AppShell({ children }: Props) {
  const { uiLanguage, setUiLanguage, t } = useUiLanguage();
  const sessionId = useAppStore((s) => s.sessionId);
  const location = useLocation();

  // Keep document lang in sync
  useEffect(() => {
    document.documentElement.lang = uiLanguage;
  }, [uiLanguage]);

  const nextLanguage = uiLanguage === "en" ? "ja" : "en";

  // Review page manages its own full-screen layout — render without the shell header
  const isReviewPage = location.pathname === "/review";

  if (isReviewPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-surface-muted)]">
      {/* ─── Top navigation bar ─── */}
      <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 shadow-[var(--shadow-sm)]">
        {/* Left: App name */}
        <div className="flex items-center gap-4">
          <span className="text-sm font-bold tracking-tight text-[var(--color-text)]">
            IMDF Converter
          </span>
          {sessionId ? (
            <span className="hidden text-[11px] text-[var(--color-text-muted)] sm:inline">
              {sessionId.slice(0, 12)}
            </span>
          ) : null}
        </div>

        {/* Center: Step indicator */}
        <StepIndicator />

        {/* Right: Language toggle */}
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-muted)]"
          onClick={() => setUiLanguage(nextLanguage)}
          title={t("Switch UI language", "表示言語を切り替え")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M1.5 8h13" />
            <path d="M8 1.5c-1.8 2-2.7 4-2.7 6.5s.9 4.5 2.7 6.5" />
            <path d="M8 1.5c1.8 2 2.7 4 2.7 6.5s-.9 4.5-2.7 6.5" />
          </svg>
          {uiLanguage === "en" ? "日本語" : "EN"}
        </button>
      </header>

      {/* ─── Page content ─── */}
      <div className="flex-1">
        {children}
      </div>
    </div>
  );
}
