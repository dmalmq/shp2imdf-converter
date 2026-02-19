import { useMemo } from "react";

import type { CleanupSummary, ImportedFile, WizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";


type Props = {
  files: ImportedFile[];
  cleanupSummary: CleanupSummary | null;
  wizard: WizardState | null;
  saving: boolean;
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


export function SummaryStep({ files, cleanupSummary, wizard, saving, onConfirm }: Props) {
  const { t } = useUiLanguage();
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
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("Step 10: Summary", "Step 10: 概要")}</h2>
        <button
          type="button"
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
          disabled={saving}
          onClick={onConfirm}
        >
          {saving ? t("Generating...", "生成中...") : t("Confirm & Open Review", "確定してレビューへ進む")}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded border p-3 text-sm">
          <h3 className="font-semibold">{t("Project", "プロジェクト")}</h3>
          <p className="mt-1">{t("Name", "名称")}: {wizard?.project?.project_name ?? t("(none)", "（なし）")}</p>
          <p>{t("Venue", "会場")}: {wizard?.project?.venue_name ?? t("(missing)", "（未設定）")}</p>
          <p>{t("Venue category", "会場カテゴリ")}: {wizard?.project?.venue_category ?? t("(missing)", "（未設定）")}</p>
          <p>{t("Address", "住所")}: {formatVenueAddress(wizard)}</p>
        </div>

        <div className="rounded border p-3 text-sm">
          <h3 className="font-semibold">{t("Coverage", "集計")}</h3>
          <p>{t("Files total", "ファイル総数")}: {files.length}</p>
          <p>
            {t("Levels", "レベル")}: {levelOrdinals.length}{" "}
            {levelMin !== null && levelMax !== null && t(`(range ${levelMin} to ${levelMax})`, `（${levelMin} 〜 ${levelMax}）`)}
          </p>
          <p>{t("Buildings", "建物数")}: {wizard?.buildings.length ?? 0}</p>
          <p>
            {t("Unit code mappings", "Unit コード対応")}: {mappedCodes}{" "}
            {t(`(${unresolvedCodes} unresolved)`, `（未解決 ${unresolvedCodes}）`)}
          </p>
          <p>{t("Footprint method", "Footprint 生成方法")}: {wizard?.footprint.method ?? "union_buffer"}</p>
          <p>{t("Language", "言語")}: {wizard?.project?.language ?? "en"}</p>
        </div>
      </div>

      <div className="mt-4 rounded border">
        <div className="border-b bg-slate-50 px-3 py-2 text-sm font-semibold">{t("Files by Detected Type", "検出種別ごとのファイル数")}</div>
        <ul className="px-3 py-2 text-sm">
          {typeCounts.map(([featureType, count]) => (
            <li key={featureType}>
              {featureType}: {count}
            </li>
          ))}
        </ul>
      </div>

      {cleanupSummary && (
        <div className="mt-4 rounded border p-3 text-sm">
          <h3 className="font-semibold">{t("Import Cleanup Summary", "インポート時クリーンアップ結果")}</h3>
          <ul className="mt-1">
            <li>{t("Multipolygons exploded", "マルチポリゴン分割数")}: {cleanupSummary.multipolygons_exploded}</li>
            <li>{t("Rings closed", "リング補完数")}: {cleanupSummary.rings_closed}</li>
            <li>{t("Features reoriented", "向き修正数")}: {cleanupSummary.features_reoriented}</li>
            <li>{t("Empty features dropped", "空フィーチャ除外数")}: {cleanupSummary.empty_features_dropped}</li>
            <li>{t("Coordinates rounded", "座標丸め数")}: {cleanupSummary.coordinates_rounded}</li>
          </ul>
        </div>
      )}

      {wizard && wizard.warnings.length > 0 && (
        <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <h3 className="font-semibold">{t("Warnings", "警告")}</h3>
          <ul className="mt-1">
            {wizard.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
