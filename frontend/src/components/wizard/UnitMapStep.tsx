import { useMemo } from "react";

import type { ImportedFile, UnitMappingState, UnitCodePreviewRow } from "../../api/client";


type Props = {
  files: ImportedFile[];
  mapping: UnitMappingState;
  saving: boolean;
  onSave: (mapping: UnitMappingState) => void;
  onUploadCompanyMappings: (file: File) => void;
};


function uniqueColumns(files: ImportedFile[]): string[] {
  const values = new Set<string>();
  files.forEach((file) => {
    file.attribute_columns.forEach((column) => values.add(column));
  });
  return [...values].sort((a, b) => a.localeCompare(b));
}


function unresolvedCount(preview: UnitCodePreviewRow[]): number {
  return preview.filter((row) => row.unresolved).length;
}


export function UnitMapStep({ files, mapping, saving, onSave, onUploadCompanyMappings }: Props) {
  const unitFiles = useMemo(() => files.filter((item) => item.detected_type === "unit"), [files]);
  const columns = useMemo(() => uniqueColumns(unitFiles), [unitFiles]);
  const unresolved = useMemo(() => unresolvedCount(mapping.preview), [mapping.preview]);

  const updateField = (key: keyof UnitMappingState, value: string | null) => {
    onSave({
      ...mapping,
      [key]: value
    });
  };

  return (
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Step 5: Unit Mapping</h2>
        <label className="rounded border px-3 py-1.5 text-sm">
          Upload company mappings
          <input
            type="file"
            className="hidden"
            accept="application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onUploadCompanyMappings(file);
              }
              event.target.value = "";
            }}
          />
        </label>
      </div>

      <div className="mb-3 grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Code Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.code_column ?? ""}
            onChange={(event) => updateField("code_column", event.target.value || null)}
          >
            <option value="">(none)</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Name Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.name_column ?? ""}
            onChange={(event) => updateField("name_column", event.target.value || null)}
          >
            <option value="">(none)</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Alt Name Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.alt_name_column ?? ""}
            onChange={(event) => updateField("alt_name_column", event.target.value || null)}
          >
            <option value="">(none)</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Restriction Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.restriction_column ?? ""}
            onChange={(event) => updateField("restriction_column", event.target.value || null)}
          >
            <option value="">(none)</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-slate-600">Accessibility Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.accessibility_column ?? ""}
            onChange={(event) => updateField("accessibility_column", event.target.value || null)}
          >
            <option value="">(none)</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded border">
        <div className="flex items-center justify-between border-b bg-slate-50 px-3 py-2 text-sm">
          <span>Code Resolution Preview</span>
          <span className={unresolved ? "text-amber-700" : "text-emerald-700"}>
            {mapping.preview.length} codes, {unresolved} unresolved
          </span>
        </div>
        <div className="max-h-64 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-2 py-2">Raw Code</th>
                <th className="px-2 py-2">Count</th>
                <th className="px-2 py-2">Resolved Category</th>
              </tr>
            </thead>
            <tbody>
              {mapping.preview.map((row) => (
                <tr key={row.code} className={`border-t ${row.unresolved ? "bg-amber-50" : "bg-white"}`}>
                  <td className="px-2 py-2 font-mono text-xs">{row.code}</td>
                  <td className="px-2 py-2">{row.count}</td>
                  <td className="px-2 py-2">{row.resolved_category}</td>
                </tr>
              ))}
              {mapping.preview.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-sm text-slate-500" colSpan={3}>
                    Select a code column to generate coverage preview.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {saving && <p className="mt-2 text-xs text-slate-500">Saving mappings...</p>}
    </section>
  );
}
