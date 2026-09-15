import { useMemo } from "react";

import type { FixtureMappingState, ImportedFile } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { ColumnField } from "./ColumnField";


type Props = {
  files: ImportedFile[];
  mapping: FixtureMappingState;
  onSave: (mapping: FixtureMappingState) => void;
};


function uniqueColumns(files: ImportedFile[]): string[] {
  const values = new Set<string>();
  files.forEach((file) => {
    file.attribute_columns.forEach((column) => values.add(column));
  });
  return [...values].sort((a, b) => a.localeCompare(b));
}


export function FixtureMapStep({ files, mapping, onSave }: Props) {
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
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <ColumnField
          label={t("Name Column", "名称列")}
          columns={columns}
          value={mapping.name_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("name_column", value)}
        />
        <ColumnField
          label={t("Alt Name Column", "別名列")}
          columns={columns}
          value={mapping.alt_name_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("alt_name_column", value)}
        />
        <ColumnField className="md:col-span-2"
          label={t("Category Column", "カテゴリ列")}
          columns={columns}
          value={mapping.category_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("category_column", value)}
        />
      </div>
    </section>
  );
}
