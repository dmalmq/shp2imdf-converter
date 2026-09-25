import { Check, ChevronRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import type { CleanupSummary, ImportedFile, WizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { TYPE_LABELS } from "../../lib/bringIn";
import type { ChecklistItem, SetUpView } from "../../lib/setUp";
import { cn } from "@/lib/utils";
import { Button } from "../ui";
import { SetUpCard } from "./SetUpCard";
import { useFooterAction } from "./wizardSave";


type Props = {
  view: SetUpView;
  files: ImportedFile[];
  cleanupSummary: CleanupSummary | null;
  wizard: WizardState | null;
  onFix: (item: Pick<ChecklistItem, "fix" | "field">) => void;
  onConfirm: () => void;
};


export function SummaryStep({ view, files, cleanupSummary, wizard, onFix, onConfirm }: Props) {
  const { t } = useUiLanguage();

  useFooterAction(onConfirm, {
    enabled: view.canGenerate,
    label: t("Generate & open Review", "生成してレビューへ"),
    blockedReason: view.left === 1 ? t("1 thing left", "残り 1 件") : t(`${view.left} things left`, `残り ${view.left} 件`)
  });

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of files) counts.set(file.detected_type || "", (counts.get(file.detected_type || "") ?? 0) + 1);
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [files]);

  const ordinals = files.map((file) => file.detected_level).filter((value): value is number => value !== null);
  const levels = ordinals.length
    ? `${ordinals.length} (${Math.min(...ordinals)} … ${Math.max(...ordinals)})`
    : "0";
  const { mapped, unresolved } = view.unitCodes;

  return (
    <section className="flex flex-col gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SetUpCard title={t("Before you generate", "生成の前に")} intro={t("Required for the IMDF venue and address records.", "IMDF の会場と住所のレコードに必要です。")}>
          <ul>
            {view.checklist.map((item) => (
              <li key={item.id} className="flex min-h-12 items-center gap-3 border-b border-border py-2 last:border-b-0">
                {item.done ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-foreground" strokeWidth={2.5} />
                ) : (
                  <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-muted-foreground/60" />
                )}
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                  <span className={cn("text-[13px]", item.done ? "text-muted-foreground" : "font-medium text-foreground")}>
                    {t(item.label.en, item.label.ja)}
                  </span>
                  {!item.done && item.where ? (
                    <span className="text-xs text-muted-foreground">{t(item.where.en, item.where.ja)}</span>
                  ) : null}
                </span>
                {item.done ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t(`Fix: ${item.label.en}`, `修正：${item.label.ja}`)}
                    onClick={() => onFix(item)}
                  >
                    {t("Fix", "修正")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </SetUpCard>

        <SetUpCard title={t("Coverage", "集計")}>
          <dl>
            <Row label={t("Files", "ファイル")} value={String(files.length)} />
            <Row label={t("Levels", "レベル")} value={levels} />
            <Row label={t("Buildings", "建物")} value={String(wizard?.buildings.length ?? 0)} />
            {unresolved > 0 ? (
              <div className="my-1 flex items-center gap-3 rounded-lg bg-warning-surface px-3 py-2">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                <dt className="flex-1 text-[13px] text-warning-foreground">{t("Unit codes", "ユニットのコード")}</dt>
                <dd className="font-mono text-[11px] text-warning-foreground">
                  {t(`${mapped} mapped · ${unresolved} unresolved`, `対応 ${mapped} · 未解決 ${unresolved}`)}
                </dd>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("Fix: Unit codes", "修正：ユニットのコード")}
                  onClick={() => onFix({ fix: "unit" })}
                >
                  {t("Fix", "修正")}
                </Button>
              </div>
            ) : (
              <Row label={t("Unit codes", "ユニットのコード")} value={String(mapped)} />
            )}
            <Row label={t("Footprint", "フットプリント")} value={wizard?.footprint.method ?? "union_buffer"} />
          </dl>
        </SetUpCard>
      </div>

      <SetUpCard title={t("Files by detected type", "検出種別ごとのファイル数")}>
        <dl>
          {typeCounts.map(([type, count]) => {
            const label = TYPE_LABELS[type];
            return (
              <Row
                key={type}
                label={
                  <>
                    {type ? (label ? t(label.en, label.ja) : type) : t("No type yet", "種類未設定")}
                    {type ? <span className="ml-2 font-mono text-[11px] text-muted-foreground">{type}</span> : null}
                  </>
                }
                value={String(count)}
              />
            );
          })}
        </dl>
      </SetUpCard>

      {wizard && wizard.warnings.length > 0 ? (
        <div className="rounded-[14px] border border-warning/30 bg-warning-surface p-5">
          <h2 className="text-[15px] font-semibold text-warning-foreground">{t("Warnings", "警告")}</h2>
          <ul className="mt-1.5 flex flex-col gap-1 text-[13px] leading-[18px] text-warning-foreground">
            {wizard.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {cleanupSummary ? (
        <details className="group rounded-[14px] border border-border bg-card p-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            {t("What import cleaned up", "インポート時のクリーンアップ")}
          </summary>
          <dl className="mt-2">
            <Row label={t("Multipolygons exploded", "マルチポリゴン分割")} value={String(cleanupSummary.multipolygons_exploded)} />
            <Row label={t("Rings closed", "リング補完")} value={String(cleanupSummary.rings_closed)} />
            <Row label={t("Features reoriented", "向き修正")} value={String(cleanupSummary.features_reoriented)} />
            <Row label={t("Empty features dropped", "空フィーチャ除外")} value={String(cleanupSummary.empty_features_dropped)} />
            <Row label={t("Coordinates rounded", "座標丸め")} value={String(cleanupSummary.coordinates_rounded)} />
          </dl>
        </details>
      ) : null}
    </section>
  );
}


/** Label left, value right in mono, so the numbers line up as a column. */
function Row({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-xs text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}
