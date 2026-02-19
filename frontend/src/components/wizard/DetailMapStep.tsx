import { useMemo } from "react";

import type { ImportedFile } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";


type Props = {
  files: ImportedFile[];
  detailConfirmed: boolean;
  saving: boolean;
  onSave: (confirmed: boolean) => void;
};


export function DetailMapStep({ files, detailConfirmed, saving, onSave }: Props) {
  const { t } = useUiLanguage();
  const detailFiles = useMemo(() => files.filter((item) => item.detected_type === "detail"), [files]);
  const detailFeatureCount = useMemo(
    () => detailFiles.reduce((sum, file) => sum + file.feature_count, 0),
    [detailFiles]
  );

  return (
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">{t("Step 8: Detail Mapping", "Step 8: Detail 設定")}</h2>
      <p className="mt-2 text-sm text-slate-600">
        {t(
          "Detail features require no attribute mapping. They will export with geometry + level assignment from Step 3.",
          "Detail は属性マッピング不要です。Step 3 の level 設定のみを使って出力されます。"
        )}
      </p>
      <div className="mt-3 rounded border bg-slate-50 p-3 text-sm">
        <p>
          {t("Detail files detected", "Detail ファイル数")}: <span className="font-semibold">{detailFiles.length}</span>
        </p>
        <p>
          {t("Detail features total", "Detail フィーチャ総数")}: <span className="font-semibold">{detailFeatureCount}</span>
        </p>
      </div>
      {detailFiles.length > 0 && (
        <>
          <label className="mt-4 flex items-start gap-2 rounded border border-slate-200 p-3 text-sm">
            <input
              type="checkbox"
              checked={detailConfirmed}
              onChange={(event) => onSave(event.target.checked)}
              disabled={saving}
            />
            <span>
              {t(
                "I confirm detail features should export as LineString geometry with only `level_id` properties.",
                "detail を `level_id` のみを持つ LineString として出力することを確認しました。"
              )}
            </span>
          </label>
          <ul className="mt-3 space-y-1 text-xs text-slate-600">
            {detailFiles.map((file) => (
              <li key={file.stem} className="font-mono">
                {file.stem}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
