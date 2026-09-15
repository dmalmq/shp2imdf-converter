import { useMemo } from "react";

import type { ImportedFile, OpeningMappingState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { ColumnField } from "./ColumnField";


type Props = {
  files: ImportedFile[];
  mapping: OpeningMappingState;
  onSave: (mapping: OpeningMappingState) => void;
};


function uniqueColumns(files: ImportedFile[]): string[] {
  const values = new Set<string>();
  files.forEach((file) => {
    file.attribute_columns.forEach((column) => values.add(column));
  });
  return [...values].sort((a, b) => a.localeCompare(b));
}


export function OpeningMapStep({ files, mapping, onSave }: Props) {
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
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <ColumnField
          label={t("Category Column", "カテゴリ列")}
          columns={columns}
          value={mapping.category_column}
          emptyLabel={t("Default: pedestrian", "未設定時は pedestrian")}
          onChange={(value) => updateField("category_column", value)}
        />
        <ColumnField
          label={t("Name Column", "名称列")}
          columns={columns}
          value={mapping.name_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("name_column", value)}
        />
        <ColumnField
          label={t("Accessibility Column", "アクセシビリティ列")}
          columns={columns}
          value={mapping.accessibility_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("accessibility_column", value)}
        />
        <ColumnField
          label={t("Access Control Column", "入退室制御列")}
          columns={columns}
          value={mapping.access_control_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("access_control_column", value)}
        />
        <ColumnField
          label={t("Door Automatic Column", "自動ドア列")}
          columns={columns}
          value={mapping.door_automatic_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("door_automatic_column", value)}
        />
        <ColumnField
          label={t("Door Material Column", "ドア材質列")}
          columns={columns}
          value={mapping.door_material_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("door_material_column", value)}
        />
        <ColumnField
          label={t("Door Type Column", "ドア種別列")}
          columns={columns}
          value={mapping.door_type_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("door_type_column", value)}
        />
      </div>
    </section>
  );
}
