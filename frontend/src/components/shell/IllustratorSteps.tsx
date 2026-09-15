import { Check } from "lucide-react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useAppStore } from "../../store/useAppStore";
import { cn } from "@/lib/utils";

/**
 * The Illustrator route's own three stages.
 *
 * It used to inherit the shapefile wizard's `Import → Configure → Review & Export`
 * rail, which has no entry for this route — `stepStatus` computed `currentIndex = -1`
 * and returned "pending" for all three, so the bar was inert *and* described a
 * different product. These are the stages this route actually has.
 */
const STEPS = [
  { en: "Artwork", ja: "図面" },
  { en: "Floors", ja: "フロア" },
  { en: "Place & export", ja: "配置と書き出し" }
] as const;

export function IllustratorSteps() {
  const { t } = useUiLanguage();
  const stage = useAppStore((s) => s.illustratorStage);

  return (
    <nav aria-label={t("Progress", "進捗")} className="flex items-center gap-1">
      {STEPS.map((step, index) => {
        const position = index + 1;
        const done = position < stage;
        const active = position === stage;

        return (
          <div
            key={step.en}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full py-1 pl-2 pr-3",
              active && "bg-secondary"
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[10px] leading-none",
                active && "bg-primary text-primary-foreground",
                done && "bg-success text-primary-foreground",
                !active && !done && "bg-muted text-muted-foreground"
              )}
            >
              {done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : position}
            </span>
            <span
              className={cn(
                "text-xs leading-4",
                active ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {t(step.en, step.ja)}
            </span>
          </div>
        );
      })}
    </nav>
  );
}
