import type { ImportedFile } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { TYPE_OPTIONS } from "../../lib/bringIn";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";
import { ConfidenceDot } from "../shared/ConfidenceDot";
import { PreviewMap } from "../shared/PreviewMap";

type BasicFeature = {
  type: string;
  feature_type?: string;
  geometry?: {
    type: string;
    coordinates: unknown;
  } | null;
  properties?: {
    source_file?: string;
    [key: string]: unknown;
  };
};

type Props = {
  files: ImportedFile[];
  features: BasicFeature[];
  selectedStem: string | null;
  hoveredStem: string | null;
  loading: boolean;
  onDetectAll: () => void;
  onChangeType: (stem: string, nextType: string) => void;
  onSelectStem: (stem: string | null) => void;
  onHoverStem: (stem: string | null) => void;
};


// Radix Select has no empty-string value, so "not classified" needs a sentinel.
const UNKNOWN_TYPE = "__unknown__";


export function FileClassStep({
  files,
  features,
  selectedStem,
  hoveredStem,
  loading,
  onDetectAll,
  onChangeType,
  onSelectStem,
  onHoverStem
}: Props) {
  const { t } = useUiLanguage();

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem] 2xl:grid-cols-[minmax(0,1fr)_28rem]">
      <div className="min-w-0 rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-end">
          <Button variant="outline" size="sm" disabled={loading} onClick={onDetectAll}>
            {loading ? t("Detecting…", "検出中…") : t("Re-detect all", "一括検出")}
          </Button>
        </div>
        <div className="max-h-[58vh] min-h-[430px] overflow-auto rounded-lg border border-border">
          <table className="w-full min-w-[34rem] table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: "42%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "16%" }} />
            </colgroup>
            <thead className="sticky top-0 bg-muted text-left font-mono text-[10px] uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">{t("Source", "ソース")}</th>
                <th className="px-3 py-2.5">{t("Geometry", "ジオメトリ")}</th>
                <th className="px-3 py-2.5">{t("Count", "件数")}</th>
                <th className="px-3 py-2.5">{t("IMDF Type", "IMDF 種別")}</th>
                <th className="px-3 py-2.5">{t("Confidence", "信頼度")}</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const isSelected = selectedStem === file.stem;
                const rowClass = isSelected ? "bg-accent" : "bg-card";
                return (
                  <tr
                    key={file.stem}
                    className={`${rowClass} cursor-pointer border-t border-border hover:bg-muted`}
                    onMouseEnter={() => onHoverStem(file.stem)}
                    onMouseLeave={() => onHoverStem(null)}
                    onClick={() => onSelectStem(isSelected ? null : file.stem)}
                  >
                    <td
                      className="px-3 py-2.5 font-mono text-xs"
                      title={file.source_layer ? `${file.stem} (${file.source_layer})` : file.stem}
                    >
                      <div className="truncate">{file.stem}</div>
                      {file.source_format === "gpkg" && file.source_layer ? (
                        <div className="truncate font-sans text-[10px] text-muted-foreground">
                          {t(`Layer: ${file.source_layer}`, `レイヤー: ${file.source_layer}`)}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">{file.geometry_type}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{file.feature_count}</td>
                    <td className="px-3 py-2.5">
                      <Select
                        value={file.detected_type || UNKNOWN_TYPE}
                        onValueChange={(value) =>
                          onChangeType(file.stem, value === UNKNOWN_TYPE ? "" : value)
                        }
                      >
                        <SelectTrigger
                          className="h-8"
                          aria-label={t(`Type of ${file.stem}`, `${file.stem} の種別`)}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNKNOWN_TYPE}>{t("Unknown", "未設定")}</SelectItem>
                          {TYPE_OPTIONS.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <ConfidenceDot confidence={file.confidence} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="mb-2 text-sm font-semibold text-foreground">{t("Preview Map", "プレビューマップ")}</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("Hover a row to zoom/highlight. Click a row to isolate that file.", "行にカーソルを置くと強調表示・ズームします。クリックでそのファイルのみ表示します。")}
        </p>
        <PreviewMap features={features} selectedStem={selectedStem} hoveredStem={hoveredStem} />
      </div>
    </section>
  );
}
