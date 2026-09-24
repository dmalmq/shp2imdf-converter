import { Check, Lock } from "lucide-react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { cn } from "@/lib/utils";
import type { Stage } from "./stages";

type Props = {
  stages: Stage[];
  onSelect: (stage: Stage) => void;
};

/** B+'s four-stage track (Figma 117:30), directly under the top bar. */
export function StageTrack({ stages, onSelect }: Props) {
  const { t } = useUiLanguage();

  return (
    <nav
      aria-label={t("Stages", "ステージ")}
      className="shrink-0 border-b border-border bg-background px-8 py-2"
    >
      <ol className="flex items-center gap-2">
        {stages.map((stage, index) => {
          const position = index + 1;
          const label = `${position} · ${t(stage.label.en, stage.label.ja)}`;
          const detail = stage.detail ? t(stage.detail.en, stage.detail.ja) : null;
          const done = stage.status === "done";
          const current = stage.status === "current";
          const quiet = stage.status === "todo" || stage.status === "blocked";

          const body = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold leading-none",
                  done && "bg-primary text-primary-foreground",
                  current && "border-2 border-primary text-primary",
                  quiet && "border-2 border-border text-muted-foreground"
                )}
              >
                {done ? (
                  <Check className="h-3 w-3" strokeWidth={3} />
                ) : stage.status === "blocked" ? (
                  <Lock className="h-2.5 w-2.5" strokeWidth={2.5} />
                ) : (
                  position
                )}
              </span>
              <span className="flex min-w-0 flex-col items-start text-left">
                <span
                  className={cn(
                    "whitespace-nowrap text-[13px] font-semibold leading-[18px]",
                    quiet ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  {label}
                </span>
                {detail ? (
                  <span
                    className={cn(
                      "whitespace-nowrap text-[11px] leading-[14px]",
                      stage.detailTone === "danger" ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {detail}
                  </span>
                ) : null}
              </span>
              {stage.status === "blocked" ? (
                <span className="sr-only">{t("(not available yet)", "（まだ利用できません）")}</span>
              ) : done ? (
                <span className="sr-only">{t("(done)", "（完了）")}</span>
              ) : null}
            </>
          );

          const box = cn(
            "flex items-center gap-2.5 rounded-xl py-1.5 pl-2 pr-3.5",
            current && "border-[1.5px] border-primary bg-card"
          );

          return (
            <li key={stage.id} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
              {stage.target ? (
                <button
                  type="button"
                  onClick={() => onSelect(stage)}
                  className={cn(
                    box,
                    "transition-colors hover:bg-muted",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  )}
                >
                  {body}
                </button>
              ) : (
                <div className={box} aria-current={current ? "step" : undefined}>
                  {body}
                </div>
              )}
              {index < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-0.5 min-w-4 flex-1 rounded-full",
                    done ? "bg-primary" : "bg-border"
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
