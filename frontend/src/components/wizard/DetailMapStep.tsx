import { useMemo } from "react";

import type { ImportedFile } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";


type Props = {
  files: ImportedFile[];
};


export function DetailMapStep({ files }: Props) {
  const { t } = useUiLanguage();
  const detailFiles = useMemo(() => files.filter((item) => item.detected_type === "detail"), [files]);
  const detailFeatureCount = useMemo(
    () => detailFiles.reduce((sum, file) => sum + file.feature_count, 0),
    [detailFiles]
  );

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <p className="text-[13px] leading-[18px] text-muted-foreground">
        {t(
          "Detail features require no attribute mapping. They export with their geometry and whatever Level Mapping assigned them.",
          "Detail は属性マッピング不要です。レベル対応付けの結果と図形のみで出力されます。"
        )}
      </p>
      <div className="mt-3 rounded border bg-muted p-3 text-sm">
        <p>
          {t("Detail files detected", "Detail ファイル数")}: <span className="font-semibold">{detailFiles.length}</span>
        </p>
        <p>
          {t("Detail features total", "Detail フィーチャ総数")}: <span className="font-semibold">{detailFeatureCount}</span>
        </p>
      </div>
      {detailFiles.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {detailFiles.map((file) => (
            <li key={file.stem} className="font-mono">
              {file.stem}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
