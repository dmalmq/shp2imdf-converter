import { useEffect, useId, useRef, useState } from "react";

import { saveHandoverNote, type HandoverNote as Note } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { formatClock } from "../../lib/clock";
import { cn } from "@/lib/utils";

type SaveState = "idle" | "saving" | "saved" | "failed";

const SAVE_DELAY_MS = 800;

/**
 * The unsigned note for whoever opens the project next (Figma 115:614). It
 * saves itself a moment after typing stops and when the field is left.
 */
export function HandoverNote({
  sessionId,
  station,
  note,
  className
}: {
  sessionId: string;
  station: string;
  note: Note | null;
  className?: string;
}) {
  const { t } = useUiLanguage();
  const id = useId();
  const [text, setText] = useState(note?.text ?? "");
  const [state, setState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(note?.at ?? null);
  const saved = useRef(note?.text ?? "");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setText(note?.text ?? "");
    saved.current = note?.text ?? "";
    setSavedAt(note?.at ?? null);
  }, [note?.text, note?.at]);

  const save = (value: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (value.trim() === saved.current.trim()) return;
    setState("saving");
    saveHandoverNote(sessionId, value).then(
      (handover) => {
        saved.current = handover.note?.text ?? "";
        setSavedAt(handover.note?.at ?? null);
        setState("saved");
      },
      () => setState("failed")
    );
  };

  const latest = useRef(text);
  latest.current = text;
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        if (latest.current.trim() !== saved.current.trim()) void saveHandoverNote(sessionId, latest.current);
      }
    },
    [sessionId]
  );

  const status =
    state === "saving"
      ? t("Saving…", "保存中…")
      : state === "failed"
        ? t("Could not save the note. It will try again when you leave the field.", "メモを保存できませんでした。欄を離れると再度保存します。")
        : savedAt && text.trim()
          ? t(`Saved · ${formatClock(Date.parse(savedAt))}`, `保存済み · ${formatClock(Date.parse(savedAt))}`)
          : t("No names are kept. Anyone who opens this project sees it.", "名前は残りません。このプロジェクトを開いた人全員に表示されます。");

  return (
    <section
      aria-labelledby={`${id}-label`}
      className={cn("flex flex-col gap-2 rounded-[14px] border border-dashed border-border p-4", className)}
    >
      <label id={`${id}-label`} htmlFor={`${id}-text`} className="text-[13px] font-semibold text-foreground">
        {t(`Leave a note for whoever opens ${station} next`, `次に ${station} を開く人へのメモ`)}
      </label>
      <textarea
        id={`${id}-text`}
        value={text}
        maxLength={2000}
        rows={2}
        placeholder={t(
          "e.g. Delivered to Apple 24 Sep. 屋外 outline still provisional.",
          "例：9月24日に Apple へ納品。屋外の外形はまだ仮。"
        )}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          setState("idle");
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => save(value), SAVE_DELAY_MS);
        }}
        onBlur={() => save(text)}
        className={cn(
          "min-h-[2.5rem] w-full resize-y rounded-lg border border-input bg-card px-2.5 py-2 text-[12.5px] text-foreground",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
      />
      <p
        aria-live="polite"
        className={cn("text-[11.5px]", state === "failed" ? "text-destructive" : "text-muted-foreground")}
      >
        {status}
      </p>
    </section>
  );
}
