import { useMemo } from "react";

import type { ImportedFile, OpeningMappingState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";


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
  const { t } = useUiLanguage();
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
        <h2 className="text-lg font-semibold">{t("Step 6: Opening Mapping", "Step 6: Opening 対応付け")}</h2>
        {saving && <span className="text-xs text-slate-500">{t("Saving...", "保存中...")}</span>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Category Column", "カテゴリ列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.category_column ?? ""}
            onChange={(event) => updateField("category_column", event.target.value || null)}
          >
            <option value="">{t("(default to pedestrian)", "（未設定時は pedestrian）")}</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Name Column", "名称列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.name_column ?? ""}
            onChange={(event) => updateField("name_column", event.target.value || null)}
          >
            <option value="">{t("(none)", "（なし）")}</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Accessibility Column", "アクセシビリティ列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.accessibility_column ?? ""}
            onChange={(event) => updateField("accessibility_column", event.target.value || null)}
          >
            <option value="">{t("(none)", "（なし）")}</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Access Control Column", "入退室制御列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.access_control_column ?? ""}
            onChange={(event) => updateField("access_control_column", event.target.value || null)}
          >
            <option value="">{t("(none)", "（なし）")}</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Door Automatic Column", "自動ドア列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.door_automatic_column ?? ""}
            onChange={(event) => updateField("door_automatic_column", event.target.value || null)}
          >
            <option value="">{t("(none)", "（なし）")}</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Door Material Column", "ドア材質列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.door_material_column ?? ""}
            onChange={(event) => updateField("door_material_column", event.target.value || null)}
          >
            <option value="">{t("(none)", "（なし）")}</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t("Door Type Column", "ドア種別列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.door_type_column ?? ""}
            onChange={(event) => updateField("door_type_column", event.target.value || null)}
          >
            <option value="">{t("(none)", "（なし）")}</option>
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
