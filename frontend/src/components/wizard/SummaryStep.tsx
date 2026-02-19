import { useMemo } from "react";

import type { CleanupSummary, ImportedFile, WizardState } from "../../api/client";


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
        <h2 className="text-lg font-semibold">Step 10: Summary</h2>
        <button
          type="button"
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
          disabled={saving}
          onClick={onConfirm}
        >
          {saving ? "Generating..." : "Confirm & Open Review"}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded border p-3 text-sm">
          <h3 className="font-semibold">Project</h3>
          <p className="mt-1">Name: {wizard?.project?.project_name ?? "(none)"}</p>
          <p>Venue: {wizard?.project?.venue_name ?? "(missing)"}</p>
          <p>Venue category: {wizard?.project?.venue_category ?? "(missing)"}</p>
          <p>Address: {formatVenueAddress(wizard)}</p>
        </div>

        <div className="rounded border p-3 text-sm">
          <h3 className="font-semibold">Coverage</h3>
          <p>Files total: {files.length}</p>
          <p>
            Levels: {levelOrdinals.length} {levelMin !== null && levelMax !== null && `(range ${levelMin} to ${levelMax})`}
          </p>
          <p>Buildings: {wizard?.buildings.length ?? 0}</p>
          <p>
            Unit code mappings: {mappedCodes} ({unresolvedCodes} unresolved)
          </p>
          <p>Footprint method: {wizard?.footprint.method ?? "union_buffer"}</p>
          <p>Language: {wizard?.project?.language ?? "en"}</p>
        </div>
      </div>

      <div className="mt-4 rounded border">
        <div className="border-b bg-slate-50 px-3 py-2 text-sm font-semibold">Files by Detected Type</div>
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
          <h3 className="font-semibold">Import Cleanup Summary</h3>
          <ul className="mt-1">
            <li>Multipolygons exploded: {cleanupSummary.multipolygons_exploded}</li>
            <li>Rings closed: {cleanupSummary.rings_closed}</li>
            <li>Features reoriented: {cleanupSummary.features_reoriented}</li>
            <li>Empty features dropped: {cleanupSummary.empty_features_dropped}</li>
            <li>Coordinates rounded: {cleanupSummary.coordinates_rounded}</li>
          </ul>
        </div>
      )}

      {wizard && wizard.warnings.length > 0 && (
        <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <h3 className="font-semibold">Warnings</h3>
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
