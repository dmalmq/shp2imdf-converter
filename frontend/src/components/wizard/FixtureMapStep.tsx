import { useMemo } from "react";

import type { FixtureMappingState, ImportedFile } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";


type Props = {
  files: ImportedFile[];
  mapping: FixtureMappingState;
  saving: boolean;
  onSave: (mapping: FixtureMappingState) => void;
};


function uniqueColumns(files: ImportedFile[]): string[] {
  const values = new Set<string>();
  files.forEach((file) => {
    file.attribute_columns.forEach((column) => values.add(column));
  });
  return [...values].sort((a, b) => a.localeCompare(b));
}


export function FixtureMapStep({ files, mapping, saving, onSave }: Props) {
  const { t } = useUiLanguage();
  const fixtureFiles = useMemo(() => files.filter((item) => item.detected_type === "fixture"), [files]);
  const columns = useMemo(() => uniqueColumns(fixtureFiles), [fixtureFiles]);

  const updateField = (key: keyof FixtureMappingState, value: string | null) => {
    onSave({
      ...mapping,
      [key]: value
    });
  };

  return (
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("Step 7: Fixture Mapping", "Step 7: Fixture 対応付け")}</h2>
        {saving && <span className="text-xs text-slate-500">{t("Saving...", "保存中...")}</span>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
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
          <span className="mb-1 block text-slate-600">{t("Alt Name Column", "別名列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.alt_name_column ?? ""}
            onChange={(event) => updateField("alt_name_column", event.target.value || null)}
          >
            <option value="">{t("(none)", "（なし）")}</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-slate-600">{t("Category Column", "カテゴリ列")}</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={mapping.category_column ?? ""}
            onChange={(event) => updateField("category_column", event.target.value || null)}
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
