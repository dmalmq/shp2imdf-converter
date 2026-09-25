import { useEffect, useRef, useState } from "react";

import { fetchHandover, type Handover } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { formatDay } from "../../lib/clock";
import { eventLine, formatDuration, readDismissed, shouldWelcome, writeDismissed } from "../../lib/handover";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { HandoverNote } from "./HandoverNote";

/**
 * "Last time on 東京駅", shown when a project is opened after an idle gap
 * (a new visit, as the server delimits them). Dismissing it, by Continue,
 * Esc, the close button or a click outside, keeps it away for the rest of
 * the visit in this browser.
 */
export function WelcomeBack({ sessionId, station }: { sessionId: string; station: string }) {
  const { t, uiLanguage } = useUiLanguage();
  const [handover, setHandover] = useState<Handover | null>(null);
  const continueButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    setHandover(null);
    fetchHandover(sessionId).then(
      (loaded) => {
        if (active && shouldWelcome(loaded, readDismissed(sessionId))) setHandover(loaded);
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [sessionId]);

  const visit = handover?.last_visit;
  if (!handover || !visit) return null;

  const dismiss = () => {
    if (handover.visit_started_at) writeDismissed(sessionId, handover.visit_started_at);
    setHandover(null);
  };
  const duration = formatDuration(Date.parse(visit.ended_at) - Date.parse(visit.started_at));
  const day = formatDay(visit.started_at, uiLanguage, t);
  const events = [...visit.events].reverse();

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : dismiss())}>
      <DialogContent
        className="max-w-[520px] gap-5 p-7"
        aria-describedby="welcome-back-when"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          continueButton.current?.focus();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            {t("Welcome back", "おかえりなさい")}
          </p>
          <DialogTitle className="font-display text-[26px] font-semibold leading-tight text-foreground">
            {t(`Last time on ${station}`, `前回の ${station}`)}
          </DialogTitle>
          <DialogDescription id="welcome-back-when" className="text-[13px] text-muted-foreground">
            {t(
              `Last session · ${day} · ${duration.en}`,
              `前回のセッション · ${day} · ${duration.ja}`
            )}
          </DialogDescription>
        </div>

        <section aria-labelledby="welcome-back-changes" className="flex flex-col gap-2">
          <h3 id="welcome-back-changes" className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            {t("What changed", "変更内容")}
          </h3>
          <ul className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto rounded-lg bg-muted p-3.5">
            {events.map((event) => {
              const line = eventLine(event);
              return (
                <li key={`${event.kind}-${JSON.stringify(event.params)}`} className="flex items-baseline gap-2 text-[13px] text-foreground">
                  <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-primary" />
                  <span className="min-w-0 flex-1 break-words">{t(line.en, line.ja)}</span>
                </li>
              );
            })}
            {visit.dropped > 0 ? (
              <li className="pl-3.5 text-[12px] text-muted-foreground">
                {t(`and ${visit.dropped} earlier changes`, `ほかに以前の変更 ${visit.dropped} 件`)}
              </li>
            ) : null}
          </ul>
        </section>

        <HandoverNote sessionId={sessionId} station={station} note={handover.note} />

        <DialogFooter>
          <Button ref={continueButton} onClick={dismiss}>{t("Continue", "続ける")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
