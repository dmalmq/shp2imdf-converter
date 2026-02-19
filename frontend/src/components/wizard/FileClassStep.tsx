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
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(430px,1fr)]">
      <div className="min-w-0 rounded border bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
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
        <div className="max-h-[440px] overflow-auto rounded border">
          <table className="min-w-[900px] w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: "42%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "16%" }} />
            </colgroup>
            <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-3 py-2.5">Filename</th>
                <th className="px-3 py-2.5">Geometry</th>
                <th className="px-3 py-2.5">Count</th>
                <th className="px-3 py-2.5">IMDF Type</th>
                <th className="px-3 py-2.5">Confidence</th>
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
                    <td className="truncate px-3 py-2.5 font-mono text-xs" title={file.stem}>
                      {file.stem}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">{file.geometry_type}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{file.feature_count}</td>
                    <td className="px-3 py-2.5">
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

      <div className="rounded border bg-white p-5">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Preview Map</h3>
        <p className="mb-3 text-xs text-slate-500">
          Hover a row to zoom/highlight. Click a row to isolate that file.
        </p>
        <PreviewMap features={features} selectedStem={selectedStem} hoveredStem={hoveredStem} />
      </div>
    </section>
  );
}
