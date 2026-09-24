import { ChevronRight } from "lucide-react";
import { useMemo } from "react";

import type { CleanupSummary, ImportedFile, WizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Card, SectionHeader } from "../ui";
import { useFooterAction } from "./wizardSave";


type Props = {
  files: ImportedFile[];
  cleanupSummary: CleanupSummary | null;
  wizard: WizardState | null;
  disabled?: boolean;
  onConfirm: () => void;
};


function formatVenueAddress(wizard: WizardState | null): string {
  const project = wizard?.project;
  if (!project) {
    return "Not set";
  }
  const address = project.address;
  const addressLine = (address.address ?? "").trim() || project.venue_name || "(missing)";
  const pieces = [addressLine, address.locality, address.province, address.country, address.postal_code]
    .filter((item): item is string => Boolean(item && item.trim().length > 0))
    .map((item) => item.trim());
  return pieces.join(", ");
}


export function SummaryStep({ files, cleanupSummary, wizard, disabled, onConfirm }: Props) {
  const { t } = useUiLanguage();

  // The only section with a footer button: every other one saves as you edit,
  // and generating is an action, not a save.
  useFooterAction(onConfirm, {
    enabled: !disabled,
    label: t("Generate & open Review", "生成してレビューへ"),
    blockedReason: t(
      "Finish the sections still marked incomplete first",
      "未完了のセクションを先に完了してください"
    )
  });
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    files.forEach((file) => {
      const key = file.detected_type || "unknown";
      counts[key] = (counts[key] ?? 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const levelOrdinals = useMemo(
    () =>
      files
        .map((file) => file.detected_level)
        .filter((value): value is number => value !== null),
    [files]
  );

  const levelMin = levelOrdinals.length ? Math.min(...levelOrdinals) : null;
  const levelMax = levelOrdinals.length ? Math.max(...levelOrdinals) : null;
  const unresolvedCodes = wizard?.mappings.unit.preview.filter((item) => item.unresolved).length ?? 0;
  const mappedCodes = wizard?.mappings.unit.preview.length ?? 0;

  return (
    <section className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <SectionHeader title={t("Project", "プロジェクト")} />
          <dl className="mt-2">
            <SummaryRow
              label={t("Name", "名称")}
              value={wizard?.project?.project_name || t("Not set", "未設定")}
            />
            <SummaryRow
              label={t("Venue", "会場")}
              value={wizard?.project?.venue_name || t("Not set", "未設定")}
            />
            <SummaryRow
              label={t("Category", "カテゴリ")}
              value={wizard?.project?.venue_category || t("Not set", "未設定")}
            />
            <SummaryRow label={t("Address", "住所")} value={formatVenueAddress(wizard)} />
            <SummaryRow label={t("Language", "言語")} value={wizard?.project?.language ?? "en"} />
          </dl>
        </Card>

        <Card className="p-4">
          <SectionHeader title={t("Coverage", "集計")} />
          <dl className="mt-2">
            <SummaryRow label={t("Files", "ファイル")} value={String(files.length)} />
            <SummaryRow
              label={t("Levels", "レベル")}
              value={
                levelMin !== null && levelMax !== null
                  ? `${levelOrdinals.length} (${levelMin} … ${levelMax})`
                  : String(levelOrdinals.length)
              }
            />
            <SummaryRow label={t("Buildings", "建物")} value={String(wizard?.buildings.length ?? 0)} />
            <SummaryRow
              label={t("Unit codes", "Unit コード")}
              value={
                unresolvedCodes
                  ? t(`${mappedCodes}, ${unresolvedCodes} unresolved`, `${mappedCodes} 件、未解決 ${unresolvedCodes} 件`)
                  : String(mappedCodes)
              }
              warn={unresolvedCodes > 0}
            />
            <SummaryRow
              label={t("Footprint", "Footprint")}
              value={wizard?.footprint.method ?? "union_buffer"}
            />
          </dl>
        </Card>
      </div>

      <Card className="p-4">
        <SectionHeader title={t("Files by detected type", "検出種別ごとのファイル数")} />
        <dl className="mt-2">
          {typeCounts.map(([featureType, count]) => (
            <SummaryRow key={featureType} label={featureType} value={String(count)} />
          ))}
        </dl>
      </Card>

      {wizard && wizard.warnings.length > 0 ? (
        <div className="rounded-lg border border-warning/30 bg-warning-surface p-4">
          <h3 className="text-sm font-semibold leading-5 text-warning-foreground">{t("Warnings", "警告")}</h3>
          <ul className="mt-1.5 flex flex-col gap-1 text-[13px] leading-[18px] text-warning-foreground">
            {wizard.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* What the importer silently repaired. Worth being able to check, not
          worth five lines of zeroes on the screen you generate from. */}
      {cleanupSummary ? (
        <details className="group rounded-lg border border-border bg-card p-4">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium leading-[18px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {t("What import cleaned up", "インポート時のクリーンアップ")}
          </summary>
          <dl className="mt-2">
            <SummaryRow
              label={t("Multipolygons exploded", "マルチポリゴン分割")}
              value={String(cleanupSummary.multipolygons_exploded)}
            />
            <SummaryRow
              label={t("Rings closed", "リング補完")}
              value={String(cleanupSummary.rings_closed)}
            />
            <SummaryRow
              label={t("Features reoriented", "向き修正")}
              value={String(cleanupSummary.features_reoriented)}
            />
            <SummaryRow
              label={t("Empty features dropped", "空フィーチャ除外")}
              value={String(cleanupSummary.empty_features_dropped)}
            />
            <SummaryRow
              label={t("Coordinates rounded", "座標丸め")}
              value={String(cleanupSummary.coordinates_rounded)}
            />
          </dl>
        </details>
      ) : null}
    </section>
  );
}


/** Label left, value right in mono — the numbers line up as a column. */
function SummaryRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
      <dt className="text-[13px] leading-[18px] text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right font-mono text-[11px] leading-[14px] tracking-[0.02em] ${
          warn ? "text-warning-foreground" : "text-foreground"
        }`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
