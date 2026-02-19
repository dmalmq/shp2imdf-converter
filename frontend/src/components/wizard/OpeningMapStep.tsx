import { useMemo } from "react";

import type { ImportedFile, OpeningMappingState } from "../../api/client";


type Props = {
  files: ImportedFile[];
  mapping: OpeningMappingState;
  saving: boolean;
  onSave: (mapping: OpeningMappingState) => void;
};


function uniqueColumns(files: ImportedFile[]): string[] {
  const values = new Set<string>();
  files.forEach((file) => {
    file.attribute_columns.forEach((column) => values.add(column));
  });
  return [...values].sort((a, b) => a.localeCompare(b));
}


export function OpeningMapStep({ files, mapping, saving, onSave }: Props) {
  const openingFiles = useMemo(() => files.filter((item) => item.detected_type === "opening"), [files]);
  const columns = useMemo(() => uniqueColumns(openingFiles), [openingFiles]);

  const updateField = (key: keyof OpeningMappingState, value: string | null) => {
    onSave({
      ...mapping,
      [key]: value
    });
  };

  return (
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Step 6: Opening Mapping</h2>
        {saving && <span className="text-xs text-slate-500">Saving...</span>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Category Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.category_column ?? ""}
            onChange={(event) => updateField("category_column", event.target.value || null)}
          >
            <option value="">(default to pedestrian)</option>
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
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Access Control Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.access_control_column ?? ""}
            onChange={(event) => updateField("access_control_column", event.target.value || null)}
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
          <span className="mb-1 block text-slate-600">Door Automatic Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.door_automatic_column ?? ""}
            onChange={(event) => updateField("door_automatic_column", event.target.value || null)}
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
          <span className="mb-1 block text-slate-600">Door Material Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.door_material_column ?? ""}
            onChange={(event) => updateField("door_material_column", event.target.value || null)}
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
          <span className="mb-1 block text-slate-600">Door Type Column</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.door_type_column ?? ""}
            onChange={(event) => updateField("door_type_column", event.target.value || null)}
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
    </section>
  );
}
