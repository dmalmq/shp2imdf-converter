import { Globe, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useAppStore } from "../../store/useAppStore";
import { Button } from "../ui/button";
import { TooltipProvider } from "../ui/tooltip";
import { IllustratorSteps } from "./IllustratorSteps";
import { StepIndicator } from "./StepIndicator";


type Props = {
  children: React.ReactNode;
};


export function AppShell({ children }: Props) {
  const { uiLanguage, setUiLanguage, t } = useUiLanguage();
  const sessionId = useAppStore((s) => s.sessionId);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const location = useLocation();

  // Keep document lang in sync
  useEffect(() => {
    document.documentElement.lang = uiLanguage;
  }, [uiLanguage]);

  // The token layer keys dark off a class on <html>; nothing else reaches it.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const nextLanguage = uiLanguage === "en" ? "ja" : "en";

  // Review page manages its own full-screen layout — render without the shell header
  const isReviewPage = location.pathname === "/review";
  const isIllustrator = location.pathname === "/illustrator";

  if (isReviewPage) {
    return <TooltipProvider delayDuration={200}>{children}</TooltipProvider>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col bg-muted">
        {/* ─── Top navigation bar ─── */}
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4">
          {/* Left: app name, and on the Illustrator route the flow it belongs to */}
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold leading-[18px] tracking-tight text-foreground">
              IMDF Converter
            </span>
            {isIllustrator ? (
              <>
                <span className="text-[13px] text-muted-foreground">/</span>
                <span className="text-xs leading-4 text-muted-foreground">
                  {t("Illustrator → Shapefiles", "Illustrator → シェープファイル")}
                </span>
              </>
            ) : sessionId ? (
              <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
                {sessionId.slice(0, 12)}
              </span>
            ) : null}
          </div>

          {/* Centre: whichever flow this route actually belongs to */}
          {isIllustrator ? <IllustratorSteps /> : <StepIndicator />}

          {/* Right: display preferences */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={t("Switch theme", "テーマを切り替え")}
              title={
                theme === "dark"
                  ? t("Switch to light", "ライトに切り替え")
                  : t("Switch to dark", "ダークに切り替え")
              }
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUiLanguage(nextLanguage)}
              title={t("Switch UI language", "表示言語を切り替え")}
            >
              <Globe className="h-3.5 w-3.5" />
              {uiLanguage === "en" ? "日本語" : "EN"}
            </Button>
          </div>
        </header>

        {/* ─── Page content ─── */}
        {/* min-h-0 lets a bounded child own the remaining height; overflow-auto
            keeps every other route scrolling inside the wrapper exactly as the
            document scrolled before, rather than clipping. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {children}
        </div>
      </div>
    </TooltipProvider>
  );
}
