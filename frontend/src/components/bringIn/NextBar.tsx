import { forwardRef, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { NextStep } from "../../lib/bringIn";
import { cn } from "@/lib/utils";
import { Button, DisabledHint } from "../ui";

type Props = {
  step: NextStep;
  onGo: () => void;
  /** Percent read so far while the files upload. */
  progress?: number | null;
  secondary?: ReactNode;
};

/** The bar under Bring in: what stands between the operator and the next stage, and the way on. */
export const NextBar = forwardRef<HTMLDivElement, Props>(function NextBar({ step, onGo, progress = null, secondary }, ref) {
  const { t } = useUiLanguage();
  const busy = progress !== null;
  const label = busy ? t(`Reading… ${progress}%`, `読み込み中… ${progress}%`) : t(step.action.en, step.action.ja);
  const blocked = step.blocked ? t(step.blocked.en, step.blocked.ja) : null;

  return (
    <section
      aria-label={t("Next step", "次のステップ")}
      className="flex shrink-0 items-center gap-4 border-t border-border bg-card px-14 py-3.5"
    >
      <span
        aria-hidden="true"
        className={cn("h-2.5 w-2.5 shrink-0 rounded-full", step.blocked ? "bg-destructive" : "bg-primary")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="truncate text-sm font-semibold text-foreground">
          {t(step.title.en, step.title.ja)}
        </p>
        <p className="truncate text-[12.5px] text-muted-foreground">{t(step.detail.en, step.detail.ja)}</p>
      </div>
      {secondary}
      <div ref={ref}>
        <DisabledHint hint={busy ? null : blocked}>
          <Button className="relative overflow-hidden" disabled={busy || Boolean(blocked)} onClick={onGo}>
            {busy ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-primary-foreground/20 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            ) : null}
            <span className="relative flex items-center gap-2">
              {label}
              {busy ? null : <ArrowRight aria-hidden="true" className="h-4 w-4" />}
            </span>
          </Button>
        </DisabledHint>
      </div>
    </section>
  );
});
