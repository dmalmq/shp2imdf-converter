import { useMemo } from "react";

import type { ImportedFile, UpdateFileRequest } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { LEVEL_REQUIRED_TYPES } from "../../lib/bringIn";
import {
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";


type Props = {
  files: ImportedFile[];
  onPatchFile: (stem: string, payload: UpdateFileRequest) => void;
};

type LevelBucket = {
  ordinal: number;
  files: ImportedFile[];
  names: string[];
};

// Japanese floor convention (inverse of detect_level_ordinal): ordinal 0 = ground = "1F",
// ordinal 1 = "2F", ordinal -1 = "B1F". Used for both the level name and short name.
function makeFloorLabel(ordinal: number | null): string {
  if (ordinal === null) {
    return "";
  }
  if (ordinal < 0) {
    return `B${Math.abs(ordinal)}F`;
  }
  return `${ordinal + 1}F`;
}


export function LevelMapStep({ files, onPatchFile }: Props) {
  const { t } = useUiLanguage();
  const levelFiles = useMemo(
    () => files.filter((item) => LEVEL_REQUIRED_TYPES.has(item.detected_type ?? "")),
    [files]
  );

  const buckets = useMemo(() => {
    const byOrdinal = new Map<number, LevelBucket>();
    levelFiles.forEach((file) => {
      const ordinal = file.detected_level ?? 0;
      const existing = byOrdinal.get(ordinal);
      if (existing) {
        existing.files.push(file);
        if (file.short_name) {
          existing.names.push(file.short_name);
        }
        return;
      }
      byOrdinal.set(ordinal, {
        ordinal,
        files: [file],
        names: file.short_name ? [file.short_name] : []
      });
    });
    return [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  }, [levelFiles]);

  const duplicateOrdinals = useMemo(() => {
    const duplicates = new Set<number>();
    buckets.forEach((bucket) => {
      const uniqueNames = new Set(bucket.names.filter(Boolean));
      if (uniqueNames.size > 1) {
        duplicates.add(bucket.ordinal);
      }
    });
    return duplicates;
  }, [buckets]);

  const gapOrdinals = useMemo(() => {
    if (buckets.length <= 1) {
      return [] as number[];
    }
    const min = buckets[0].ordinal;
    const max = buckets[buckets.length - 1].ordinal;
    const actual = new Set(buckets.map((bucket) => bucket.ordinal));
    const gaps: number[] = [];
    for (let ordinal = min; ordinal <= max; ordinal += 1) {
      if (!actual.has(ordinal)) {
        gaps.push(ordinal);
      }
    }
    return gaps;
  }, [buckets]);

  // The stacking diagram is a short list, not half the screen: giving it a
  // fixed narrow rail is what lets the table show all seven columns instead of
  // clipping Category off the right edge at 1440px.
  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 rounded-lg border border-border bg-card p-5">
        <div className="max-h-[58vh] min-h-[430px] overflow-auto rounded-lg border border-border">
          <table className="w-full min-w-[44rem] table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: "25%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "19%" }} />
            </colgroup>
            <thead className="sticky top-0 bg-muted text-left font-mono text-[10px] uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">{t("Filename", "ファイル名")}</th>
                <th className="px-3 py-2.5">{t("Type", "種別")}</th>
                <th className="px-3 py-2.5">{t("Detected Level", "検出レベル")}</th>
                <th className="px-3 py-2.5">{t("Level Name", "レベル名")}</th>
                <th className="px-3 py-2.5">{t("Short Name", "短縮名")}</th>
                <th className="px-3 py-2.5">{t("Outdoor", "屋外")}</th>
                <th className="px-3 py-2.5">{t("Category", "カテゴリ")}</th>
              </tr>
            </thead>
            <tbody>
              {levelFiles.map((file) => (
                <tr key={file.stem} className="border-t border-border">
                  <td className="truncate px-3 py-2.5 font-mono text-xs" title={file.stem}>
                    {file.stem}
                  </td>
                  <td className="px-3 py-2.5">{file.detected_type}</td>
                  <td className="px-3 py-2.5">
                    <Input
                      className="h-8 w-full max-w-[5rem]"
                      type="number"
                      aria-label={t(`Level of ${file.stem}`, `${file.stem} のレベル`)}
                      value={file.detected_level ?? ""}
                      onChange={(event) =>
                        onPatchFile(file.stem, {
                          detected_level: event.target.value === "" ? null : Number(event.target.value)
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Input
                      className="h-8 w-full"
                      aria-label={t(`Level name of ${file.stem}`, `${file.stem} のレベル名`)}
                      value={file.level_name ?? makeFloorLabel(file.detected_level)}
                      onChange={(event) => onPatchFile(file.stem, { level_name: event.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Input
                      className="h-8 w-full max-w-[6rem]"
                      aria-label={t(`Short name of ${file.stem}`, `${file.stem} の短縮名`)}
                      value={file.short_name ?? makeFloorLabel(file.detected_level)}
                      onChange={(event) => onPatchFile(file.stem, { short_name: event.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Checkbox
                      checked={file.outdoor}
                      aria-label={t(`${file.stem} is outdoors`, `${file.stem} は屋外`)}
                      onCheckedChange={(checked) =>
                        onPatchFile(file.stem, { outdoor: checked === true })
                      }
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Select
                      value={file.level_category}
                      onValueChange={(value) => onPatchFile(file.stem, { level_category: value })}
                    >
                      <SelectTrigger
                        className="h-8"
                        aria-label={t(`Category of ${file.stem}`, `${file.stem} のカテゴリ`)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unspecified">unspecified</SelectItem>
                        <SelectItem value="parking">parking</SelectItem>
                        <SelectItem value="transit">transit</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="mb-2 text-sm font-semibold text-foreground">{t("Stacking Diagram", "レベル構成図")}</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          {t("Levels are ordered by ordinal from bottom to top.", "レベルは下階から上階へ順に並びます。")}
        </p>
        <div className="space-y-2">
          {buckets.map((bucket) => {
            const hasDuplicate = duplicateOrdinals.has(bucket.ordinal);
            const labelClass = hasDuplicate ? "border-destructive bg-destructive/10 text-destructive" : "border-border bg-muted text-foreground";
            return (
              <div key={bucket.ordinal} className={`rounded border px-3 py-2 text-sm ${labelClass}`}>
                <div className="font-semibold">{t(`Ordinal ${bucket.ordinal}`, `階層 ${bucket.ordinal}`)}</div>
                <div className="text-xs">{t(`${bucket.files.length} file(s)`, `${bucket.files.length} ファイル`)}</div>
              </div>
            );
          })}
          {gapOrdinals.map((ordinal) => (
            <div
              key={`gap-${ordinal}`}
              className="rounded border border-dashed border-warning bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
            >
              {t(`Gap at ordinal ${ordinal}`, `階層 ${ordinal} に欠番があります`)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
