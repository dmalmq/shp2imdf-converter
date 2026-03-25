import { useMemo } from "react";

import type { ImportedFile, UpdateFileRequest } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";


type Props = {
  files: ImportedFile[];
  saving: boolean;
  onPatchFile: (stem: string, payload: UpdateFileRequest) => void;
};

type LevelBucket = {
  ordinal: number;
  files: ImportedFile[];
  names: string[];
};

const LEVEL_REQUIRED_TYPES = new Set(["unit", "opening", "fixture", "detail", "kiosk", "section"]);


function makeDefaultLevelName(ordinal: number | null): string {
  if (ordinal === null) {
    return "";
  }
  if (ordinal === 0) {
    return "Ground";
  }
  if (ordinal > 0) {
    return `Level ${ordinal}`;
  }
  return `Basement ${Math.abs(ordinal)}`;
}

function makeDefaultShortName(ordinal: number | null): string {
  if (ordinal === null) {
    return "";
  }
  if (ordinal === 0) {
    return "GH";
  }
  if (ordinal > 0) {
    return `${ordinal}F`;
  }
  return `B${Math.abs(ordinal)}`;
}


export function LevelMapStep({ files, saving, onPatchFile }: Props) {
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

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,1fr)] 2xl:grid-cols-[minmax(0,1.7fr)_minmax(400px,1fr)]">
      <div className="min-w-0 rounded border bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("Step 3: Level Mapping", "Step 3: レベル対応付け")}</h2>
          {saving && <span className="text-xs text-slate-500">{t("Saving...", "保存中...")}</span>}
        </div>

        <div className="max-h-[58vh] min-h-[430px] overflow-auto rounded border">
          <table className="min-w-[860px] w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: "30%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
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
                <tr key={file.stem} className="border-t">
                  <td className="truncate px-3 py-2.5 font-mono text-xs" title={file.stem}>
                    {file.stem}
                  </td>
                  <td className="px-3 py-2.5">{file.detected_type}</td>
                  <td className="px-3 py-2.5">
                    <input
                      className="w-full max-w-[5rem] rounded border px-2 py-1"
                      type="number"
                      value={file.detected_level ?? ""}
                      onChange={(event) =>
                        onPatchFile(file.stem, {
                          detected_level: event.target.value === "" ? null : Number(event.target.value)
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      className="w-full rounded border px-2 py-1"
                      value={file.level_name ?? makeDefaultLevelName(file.detected_level)}
                      onChange={(event) => onPatchFile(file.stem, { level_name: event.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      className="w-full max-w-[6rem] rounded border px-2 py-1"
                      value={file.short_name ?? makeDefaultShortName(file.detected_level)}
                      onChange={(event) => onPatchFile(file.stem, { short_name: event.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={file.outdoor}
                      onChange={(event) => onPatchFile(file.stem, { outdoor: event.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      className="rounded border px-2 py-1"
                      value={file.level_category}
                      onChange={(event) => onPatchFile(file.stem, { level_category: event.target.value })}
                    >
                      <option value="unspecified">unspecified</option>
                      <option value="parking">parking</option>
                      <option value="transit">transit</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded border bg-white p-5">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t("Stacking Diagram", "レベル構成図")}</h3>
        <p className="mb-4 text-xs text-slate-500">
          {t("Levels are ordered by ordinal from bottom to top.", "レベルは下階から上階へ順に並びます。")}
        </p>
        <div className="space-y-2">
          {buckets.map((bucket) => {
            const hasDuplicate = duplicateOrdinals.has(bucket.ordinal);
            const labelClass = hasDuplicate ? "border-red-400 bg-red-50 text-red-700" : "border-slate-300 bg-slate-50 text-slate-700";
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
              className="rounded border border-dashed border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-700"
            >
              {t(`Gap at ordinal ${ordinal}`, `階層 ${ordinal} に欠番があります`)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
