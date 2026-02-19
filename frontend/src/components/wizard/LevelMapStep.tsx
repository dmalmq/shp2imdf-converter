import { useMemo } from "react";

import type { ImportedFile, UpdateFileRequest } from "../../api/client";


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


function makeDefaultShortName(ordinal: number | null): string {
  if (ordinal === null) {
    return "";
  }
  if (ordinal === 0) {
    return "GF";
  }
  if (ordinal > 0) {
    return `${ordinal}F`;
  }
  return `B${Math.abs(ordinal)}`;
}


export function LevelMapStep({ files, saving, onPatchFile }: Props) {
  const levelFiles = useMemo(
    () => files.filter((item) => item.detected_type === "unit" || item.detected_type === "opening" || item.detected_type === "fixture" || item.detected_type === "detail"),
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
    <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="rounded border bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Step 3: Level Mapping</h2>
          {saving && <span className="text-xs text-slate-500">Saving...</span>}
        </div>

        <div className="max-h-[420px] overflow-auto rounded border">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-2 py-2">Filename</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Detected Level</th>
                <th className="px-2 py-2">Level Name</th>
                <th className="px-2 py-2">Short Name</th>
                <th className="px-2 py-2">Outdoor</th>
                <th className="px-2 py-2">Category</th>
              </tr>
            </thead>
            <tbody>
              {levelFiles.map((file) => (
                <tr key={file.stem} className="border-t">
                  <td className="px-2 py-2 font-mono text-xs">{file.stem}</td>
                  <td className="px-2 py-2">{file.detected_type}</td>
                  <td className="px-2 py-2">
                    <input
                      className="w-16 rounded border px-2 py-1"
                      type="number"
                      value={file.detected_level ?? ""}
                      onChange={(event) =>
                        onPatchFile(file.stem, {
                          detected_level: event.target.value === "" ? null : Number(event.target.value)
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      className="w-32 rounded border px-2 py-1"
                      value={file.level_name ?? ""}
                      onChange={(event) => onPatchFile(file.stem, { level_name: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      className="w-20 rounded border px-2 py-1"
                      value={file.short_name ?? makeDefaultShortName(file.detected_level)}
                      onChange={(event) => onPatchFile(file.stem, { short_name: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={file.outdoor}
                      onChange={(event) => onPatchFile(file.stem, { outdoor: event.target.checked })}
                    />
                  </td>
                  <td className="px-2 py-2">
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

      <div className="rounded border bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Stacking Diagram</h3>
        <p className="mb-4 text-xs text-slate-500">
          Levels are ordered by ordinal from bottom to top.
        </p>
        <div className="space-y-2">
          {buckets.map((bucket) => {
            const hasDuplicate = duplicateOrdinals.has(bucket.ordinal);
            const labelClass = hasDuplicate ? "border-red-400 bg-red-50 text-red-700" : "border-slate-300 bg-slate-50 text-slate-700";
            return (
              <div key={bucket.ordinal} className={`rounded border px-3 py-2 text-sm ${labelClass}`}>
                <div className="font-semibold">Ordinal {bucket.ordinal}</div>
                <div className="text-xs">{bucket.files.length} file(s)</div>
              </div>
            );
          })}
          {gapOrdinals.map((ordinal) => (
            <div
              key={`gap-${ordinal}`}
              className="rounded border border-dashed border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-700"
            >
              Gap at ordinal {ordinal}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

