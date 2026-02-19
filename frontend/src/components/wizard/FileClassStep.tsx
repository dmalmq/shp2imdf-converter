import type { ImportedFile } from "../../api/client";
import { ConfidenceDot } from "../shared/ConfidenceDot";
import { PreviewMap } from "../shared/PreviewMap";


const TYPE_OPTIONS = ["unit", "opening", "fixture", "detail", "level", "building", "venue"];

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
  return (
    <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="rounded border bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Step 2: File Classification</h2>
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
            disabled={loading}
            onClick={onDetectAll}
          >
            {loading ? "Detecting..." : "Detect All"}
          </button>
        </div>
        <div className="max-h-[420px] overflow-auto rounded border">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: "38%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "16%" }} />
            </colgroup>
            <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-2 py-2">Filename</th>
                <th className="px-2 py-2">Geometry</th>
                <th className="px-2 py-2">Count</th>
                <th className="px-2 py-2">IMDF Type</th>
                <th className="px-2 py-2">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const isSelected = selectedStem === file.stem;
                const rowClass = isSelected ? "bg-blue-50" : "bg-white";
                return (
                  <tr
                    key={file.stem}
                    className={`${rowClass} cursor-pointer border-t hover:bg-slate-50`}
                    onMouseEnter={() => onHoverStem(file.stem)}
                    onMouseLeave={() => onHoverStem(null)}
                    onClick={() => onSelectStem(isSelected ? null : file.stem)}
                  >
                    <td className="truncate px-2 py-2 font-mono text-xs" title={file.stem}>
                      {file.stem}
                    </td>
                    <td className="px-2 py-2">{file.geometry_type}</td>
                    <td className="px-2 py-2">{file.feature_count}</td>
                    <td className="px-2 py-2">
                      <select
                        value={file.detected_type ?? ""}
                        className="w-full min-w-[8.5rem] rounded border px-2 py-1 text-sm"
                        onChange={(event) => onChangeType(file.stem, event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <option value="">Unknown</option>
                        {TYPE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <ConfidenceDot confidence={file.confidence} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded border bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Preview Map</h3>
        <p className="mb-3 text-xs text-slate-500">
          Hover a row to zoom/highlight. Click a row to isolate that file.
        </p>
        <PreviewMap features={features} selectedStem={selectedStem} hoveredStem={hoveredStem} />
      </div>
    </section>
  );
}
