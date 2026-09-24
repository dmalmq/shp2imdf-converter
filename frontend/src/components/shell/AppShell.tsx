import { Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { formatClock } from "../../lib/clock";
import { useAppStore, type UiLanguage } from "../../store/useAppStore";
import { Button } from "../ui/button";
import { DisabledHint, TooltipProvider } from "../ui/tooltip";
import { cn } from "@/lib/utils";
import { ProductMark } from "./ProductMark";
import {
  ShellProvider,
  useAnchorInView,
  useShellSlots,
  type PageShell,
  type PrimaryAction
} from "./ShellContext";
import { StageTrack } from "./StageTrack";
import {
  artworkStages,
  currentStage,
  flowForPath,
  shapefileStages,
  stationName,
  type Stage
} from "./stages";

type Props = {
  children: React.ReactNode;
};

export function AppShell({ children }: Props) {
  return (
    <TooltipProvider delayDuration={200}>
      <ShellProvider>
        <ShellFrame>{children}</ShellFrame>
      </ShellProvider>
    </TooltipProvider>
  );
}

function ShellFrame({ children }: Props) {
  const { uiLanguage, t } = useUiLanguage();
  const theme = useAppStore((s) => s.theme);
  const location = useLocation();
  const navigate = useNavigate();
  const { primary, page } = useShellSlots();
  const stages = useStages(location.pathname, page, primary);
  const station = useStation(location.pathname, page);
  const stage = currentStage(stages);

  useEffect(() => {
    document.documentElement.lang = uiLanguage;
  }, [uiLanguage]);

  // The token layer keys dark off a class on <html>; nothing else reaches it.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const selectStage = (target: Stage) => {
    if (target.target?.kind === "route") navigate(target.target.to);
    else if (target.target?.kind === "page") page?.go?.[target.id]?.();
  };

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-border bg-card px-8">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-[9px] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          aria-label={t("shp2imdf, projects", "shp2imdf、プロジェクト")}
        >
          <ProductMark />
          <span className="font-mono text-base font-semibold leading-none text-foreground">shp2imdf</span>
        </Link>

        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />

        <nav aria-label={t("Breadcrumb", "パンくずリスト")} className="min-w-0 shrink">
          <ol className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm leading-5">
            <li>
              <Link
                to="/"
                className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("Projects", "プロジェクト")}
              </Link>
            </li>
            {station ? (
              <>
                <Separator />
                <li className="min-w-0 truncate text-muted-foreground" title={station}>
                  {station}
                </li>
              </>
            ) : null}
            {stage ? (
              <>
                <Separator />
                <li aria-current="page" className="font-medium text-foreground">
                  {t(stage.label.en, stage.label.ja)}
                </li>
              </>
            ) : null}
          </ol>
        </nav>

        {/* Search and commands arrive in phase 12; until then the space is kept, not faked. */}
        <div className="min-w-0 flex-1" data-slot="search" />

        {location.pathname === "/wizard" ? <SaveStatus held={Boolean(page?.saveHeld)} /> : null}
        <LanguageSwitch />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => useAppStore.getState().setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={t("Switch theme", "テーマを切り替え")}
          title={theme === "dark" ? t("Switch to light", "ライトに切り替え") : t("Switch to dark", "ダークに切り替え")}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
        {primary ? <PrimaryActionButton action={primary} /> : null}
      </header>

      <StageTrack stages={stages} onSelect={selectStage} />

      {/* min-h-0 lets a bounded child own the remaining height; overflow-auto
          keeps every other route scrolling inside the wrapper. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  );
}

function Separator() {
  return (
    <li aria-hidden="true" className="text-border">
      /
    </li>
  );
}

function useStages(pathname: string, page: PageShell | null, primary: PrimaryAction | null): Stage[] {
  const sessionId = useAppStore((s) => s.sessionId);
  const importProfile = useAppStore((s) => s.importProfile);
  const currentScreen = useAppStore((s) => s.currentScreen);
  const illustratorStage = useAppStore((s) => s.illustratorStage);
  const blockedReason = primary?.disabledReason && !primary.busy ? primary.disabledReason : null;

  return useMemo(() => {
    const pageStages = {
      ...page,
      // The reason is already in the operator's language.
      nextBlockedReason: blockedReason ? { en: blockedReason, ja: blockedReason } : null
    };
    return flowForPath(pathname) === "artwork"
      ? artworkStages({ illustratorStage, page: pageStages })
      : shapefileStages({
          pathname,
          hasSession: Boolean(sessionId),
          importProfile,
          reviewReached: currentScreen === "review",
          page: pageStages
        });
  }, [pathname, page, blockedReason, sessionId, importProfile, currentScreen, illustratorStage]);
}

function useStation(pathname: string, page: PageShell | null): string | null {
  const wizardState = useAppStore((s) => s.wizardState);
  const files = useAppStore((s) => s.files);
  if (page?.station) return page.station;
  // The shapefile session's name means nothing on the artwork route.
  if (flowForPath(pathname) === "artwork") return null;
  return stationName(wizardState, files);
}

function SaveStatus({ held }: { held: boolean }) {
  const { t } = useUiLanguage();
  const status = useAppStore((s) => s.wizardSaveStatus);
  const savedAt = useAppStore((s) => s.wizardSavedAt);

  let content: React.ReactNode = null;
  let dot = "bg-primary";
  // Same order as the wizard footer, so the two never disagree: a held draft
  // outranks an older "saved".
  if (status === "saving") {
    content = t("Saving…", "保存中…");
    dot = "bg-muted-foreground";
  } else if (status === "error") {
    content = t("Could not save", "保存できませんでした");
    dot = "bg-destructive";
  } else if (held) {
    content = t("Not saved yet", "未保存");
    dot = "bg-warning";
  } else if (status === "saved" && savedAt !== null) {
    content = (
      <>
        {t("Saved", "保存済み")} · <span className="font-mono">{formatClock(savedAt)}</span>
      </>
    );
  }
  if (!content) return null;

  return (
    <span
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs leading-4",
        status === "error" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {content}
    </span>
  );
}

const LANGUAGES: ReadonlyArray<{ value: UiLanguage; label: string }> = [
  { value: "en", label: "EN" },
  { value: "ja", label: "日本語" }
];

function LanguageSwitch() {
  const { uiLanguage, setUiLanguage, t } = useUiLanguage();
  return (
    <div
      role="group"
      aria-label={t("Display language", "表示言語")}
      data-language-switch=""
      className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      {LANGUAGES.map(({ value, label }) => {
        const active = uiLanguage === value;
        return (
          <button
            key={value}
            type="button"
            lang={value}
            aria-pressed={active}
            onClick={() => setUiLanguage(value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs leading-[18px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-card font-semibold text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function PrimaryActionButton({ action }: { action: PrimaryAction }) {
  const { t } = useUiLanguage();
  const inView = useAnchorInView(action.anchor);
  // Unmounting the focused button would drop focus to <body>, so it stays
  // until focus leaves it.
  const [focused, setFocused] = useState(false);
  if (inView && !focused) return null;
  const blockers = action.blockers ?? 0;
  const disabled = Boolean(action.disabledReason) || Boolean(action.busy);

  return (
    <div
      className="flex shrink-0"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <DisabledHint className="w-auto shrink-0" hint={action.busy ? null : (action.disabledReason ?? null)}>
        <Button variant={blockers > 0 ? "outline" : "default"} disabled={disabled} onClick={() => action.run()}>
          {action.label}
          {blockers > 0 ? (
            <span className="rounded-full bg-destructive px-[7px] text-[11px] font-semibold leading-[18px] text-destructive-foreground">
              {blockers}
              <span className="sr-only">{t(" to fix", " 件の要修正")}</span>
            </span>
          ) : null}
        </Button>
      </DisabledHint>
    </div>
  );
}
