import { Check, PanelLeftClose } from "lucide-react";
import type { ReactNode } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { featureLabel, undoable, type CheckGroup, type CheckView, type DoneFix } from "../../lib/check";
import { issueCopy } from "../../lib/checkCopy";
import type { ReviewFeature } from "../review/types";
import { Button } from "../ui";
import { cn } from "@/lib/utils";

type Props = {
  view: CheckView;
  /** False until a validation has been read or run. */
  validated: boolean;
  /** An edit was made since the last check, so the counts may be out of date. */
  stale: boolean;
  checking: boolean;
  busy: boolean;
  done: DoneFix[];
  focusKey: string | null;
  featuresById: ReadonlyMap<string, ReviewFeature>;
  language: string;
  onFocus: (key: string) => void;
  onUndo: (entry: DoneFix) => void;
  onCheckAgain: () => void;
  onAutoFix: () => void;
  onHide: () => void;
  /** Shown under the lists: the venue editor for IMDF-schema projects. */
  children?: ReactNode;
};

const MAX_SEGMENTS = 10;

function Progress({ fixed, left }: { fixed: number; left: number }) {
  const { t } = useUiLanguage();
  const total = fixed + left;
  const segments = Math.min(Math.max(total, 1), MAX_SEGMENTS);
  const filled = total === 0 ? segments : Math.round((fixed / total) * segments);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-[3px]" aria-hidden="true">
        {Array.from({ length: segments }, (_, index) => (
          <span key={index} className={cn("h-1.5 flex-1 rounded-[3px]", index < filled ? "bg-primary" : "bg-muted")} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {left === 0
          ? t("Nothing blocks delivery", "書き出しを妨げるものはありません")
          : t(`${fixed} fixed · ${left} left to fix`, `${fixed} 件修正済み · 残り ${left} 件`)}
      </p>
    </div>
  );
}

export function CheckRail({
  view,
  validated,
  stale,
  checking,
  busy,
  done,
  focusKey,
  featuresById,
  language,
  onFocus,
  onUndo,
  onCheckAgain,
  onAutoFix,
  onHide,
  children
}: Props) {
  const { t } = useUiLanguage();
  const nextKey = focusKey && view.mustFix.some((group) => group.key === focusKey) ? focusKey : view.mustFix[0]?.key;

  const detail = (group: CheckGroup): string | null => {
    if (group.issues.length > 1) return t(`${group.issues.length} places`, `${group.issues.length} 箇所`);
    const [issue] = group.issues;
    if (!issue.feature_id) return null;
    const first = featureLabel(featuresById.get(issue.feature_id), language);
    if (!issue.related_feature_id) return t(first.en, first.ja);
    const second = featureLabel(featuresById.get(issue.related_feature_id), language);
    return t(`${first.en} and ${second.en}`, `${first.ja}と${second.ja}`);
  };

  return (
    <aside
      aria-label={t("Before you can deliver", "書き出しの前に")}
      className="flex w-[390px] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-border bg-card py-6 pl-7 pr-6"
    >
      <div className="flex items-start gap-2">
        <h2 className="flex-1 font-display text-[22px] font-semibold leading-tight text-foreground">
          {t("Before you can deliver", "書き出しの前に")}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t("Hide the to-do list", "ToDo リストを隠す")}
          title={t("Hide the to-do list", "ToDo リストを隠す")}
          onClick={onHide}
        >
          <PanelLeftClose />
        </Button>
      </div>

      {validated && stale ? (
        <p role="status" className="rounded-[10px] bg-warning-surface p-2.5 text-xs leading-[1.45] text-warning-foreground">
          {t(
            "Changed since the last check. Check again to bring the list up to date.",
            "前回のチェックの後に変更がありました。もう一度チェックしてリストを更新してください。"
          )}
        </p>
      ) : validated ? (
        <Progress fixed={done.length} left={view.blockers} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {checking ? t("Checking the project…", "プロジェクトをチェックしています…") : t("Not checked yet", "未チェック")}
        </p>
      )}

      <Button variant={stale ? "default" : "outline"} size="sm" className="self-start" disabled={checking || busy} onClick={onCheckAgain}>
        {checking ? t("Checking…", "チェック中…") : t("Check again", "もう一度チェック")}
      </Button>

      {view.mustFix.length > 0 ? (
        <ol aria-label={t("Must fix", "要修正")} className="flex flex-col gap-3.5">
          {view.mustFix.map((group, index) => {
            const copy = issueCopy(group.check);
            const next = group.key === nextKey;
            const text = detail(group);
            return (
              <li
                key={group.key}
                className={cn(
                  "flex flex-col gap-2.5 rounded-xl p-3.5",
                  next ? "border-[1.5px] border-destructive bg-destructive-muted/40" : "border border-border bg-card"
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-destructive text-[11px] font-semibold text-destructive-foreground">
                    {index + 1}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <h3 className="text-sm font-semibold text-foreground">{t(copy.title.en, copy.title.ja)}</h3>
                    {text ? <p className="break-words text-xs leading-[1.4] text-muted-foreground">{text}</p> : null}
                  </div>
                  {group.floors.length > 0 ? (
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-[3px] font-mono text-[11px] font-medium text-muted-foreground">
                      {group.floors.length === 1 ? group.floors[0] : t(`${group.floors.length} floors`, `${group.floors.length} フロア`)}
                    </span>
                  ) : null}
                </div>
                <div className="pl-8">
                  {next ? (
                    <button
                      type="button"
                      onClick={() => onFocus(group.key)}
                      className="rounded-full bg-destructive-muted px-2.5 py-[3px] text-xs font-semibold text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t("Open on the map →", "地図で開く →")}
                    </button>
                  ) : (
                    <Button variant="outline" size="sm" className="h-[30px] rounded-[10px] text-xs" onClick={() => onFocus(group.key)}>
                      {t("Show me →", "表示 →")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {done.length > 0 ? (
        <section className="flex flex-col gap-2 pt-1" aria-label={t("Done", "完了")}>
          <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
            {t(`Done · ${done.length}`, `完了 · ${done.length}`)}
          </h3>
          <ul className="flex flex-col gap-2">
            {[...done].reverse().map((entry) => (
              <li key={entry.id} className="flex items-center gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground line-through">
                  {t(entry.label.en, entry.label.ja)}
                </span>
                {undoable(done, entry) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onUndo(entry)}
                    className="shrink-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    {t("Undo", "元に戻す")}
                  </button>
                ) : entry.stale ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{t("Edited since", "その後に編集")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.warnings > 0 ? (
        <section aria-label={t("Can wait", "後回しにできる")} className="flex flex-col gap-2 rounded-xl bg-warning-surface p-3">
          <div className="flex items-center gap-2 text-warning-foreground">
            <h3 className="flex-1 text-[13px] font-semibold">
              {t(`Can wait · ${view.warnings} warnings`, `後回しにできる · 警告 ${view.warnings} 件`)}
            </h3>
            <span className="text-[11px]">{t("Won’t block delivery", "書き出しは妨げません")}</span>
          </div>
          <ul className="flex flex-col gap-2">
            {view.canWait.map((group) => {
              const copy = issueCopy(group.check);
              const action =
                group.check === "overlapping_units"
                  ? t("Resolve", "解消")
                  : group.check === "opening_not_touching_boundary"
                    ? t("Snap", "スナップ")
                    : t("Show", "表示");
              return (
                <li key={group.key} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-[12.5px] text-foreground/80">
                    <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">
                      {group.check === "overlapping_units"
                        ? t(`${group.issues.length} pairs`, `${group.issues.length} 組`)
                        : group.issues.length}
                    </span>
                    {t(copy.title.en, copy.title.ja)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onFocus(group.key)}
                    className={cn(
                      "shrink-0 text-xs font-semibold text-warning-foreground hover:underline",
                      group.key === focusKey && "underline"
                    )}
                  >
                    {action}
                  </button>
                </li>
              );
            })}
          </ul>
          {view.autoFixable > 0 ? (
            <div className="flex items-center gap-2 border-t border-warning-foreground/20 pt-2">
              <span className="min-w-0 flex-1 text-[12.5px] text-foreground/80">
                {t(`${view.autoFixable} can be fixed automatically`, `${view.autoFixable} 件は自動で修正できます`)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={onAutoFix}
                className="shrink-0 text-xs font-semibold text-warning-foreground hover:underline disabled:opacity-50"
              >
                {t("Auto‑fix all", "すべて自動修正")}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {validated && view.mustFix.length === 0 && view.warnings === 0 ? (
        <p className="rounded-xl bg-accent p-3 text-[13px] text-foreground">
          {t("Nothing to fix. The project is ready to deliver.", "修正はありません。書き出しの準備ができています。")}
        </p>
      ) : null}

      {children}
    </aside>
  );
}
