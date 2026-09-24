import { useMemo } from "react";

import type { ImportedFile, UnitCodePreviewRow, UnitMappingState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";
import { ColumnField } from "./ColumnField";


type Props = {
  files: ImportedFile[];
  mapping: UnitMappingState;
  saving: boolean;
  onSave: (mapping: UnitMappingState) => void;
  onAssignCategory: (rawCode: string, category: string) => void;
  onUploadCompanyMappings: (file: File) => void;
};

type UnitColumnKey =
  | "code_column"
  | "name_column"
  | "alt_name_column"
  | "restriction_column"
  | "accessibility_column";


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


export function UnitMapStep({ files, mapping, saving, onSave, onAssignCategory, onUploadCompanyMappings }: Props) {
  const { t } = useUiLanguage();
  const unitFiles = useMemo(() => files.filter((item) => item.detected_type === "unit"), [files]);
  const columns = useMemo(() => uniqueColumns(unitFiles), [unitFiles]);
  const unresolved = useMemo(() => unresolvedCount(mapping.preview), [mapping.preview]);
  const categoryOptions = useMemo(() => {
    const values = new Set<string>(mapping.available_categories);
    mapping.preview.forEach((row) => values.add(row.resolved_category));
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [mapping.available_categories, mapping.preview]);

  const updateField = (key: UnitColumnKey, value: string | null) => {
    onSave({
      ...mapping,
      [key]: value
    });
  };

  const updateCodeCategory = (rawCode: string, category: string) => {
    if (!rawCode || rawCode === "(empty)" || !category) {
      return;
    }
    onAssignCategory(rawCode, category);
  };

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-end">
        <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-input px-3 text-[13px] font-medium leading-[18px] transition-colors hover:bg-accent">
          {t("Upload company mappings", "会社マッピングをアップロード")}
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
        <ColumnField
          label={t("Code Column", "コード列")}
          columns={columns}
          value={mapping.code_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("code_column", value)}
        />
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
        <ColumnField
          label={t("Restriction Column", "制限列")}
          columns={columns}
          value={mapping.restriction_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("restriction_column", value)}
        />
        <ColumnField
          className="md:col-span-2"
          label={t("Accessibility Column", "アクセシビリティ列")}
          columns={columns}
          value={mapping.accessibility_column}
          emptyLabel={t("Not mapped", "未設定")}
          onChange={(value) => updateField("accessibility_column", value)}
        />
      </div>

      <div className="mt-1 overflow-hidden rounded-lg border border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2 text-[13px] leading-[18px]">
          <span>{t("Code Resolution Preview", "コード解決プレビュー")}</span>
          <span
            className={`font-mono text-[11px] leading-[14px] tracking-[0.02em] ${unresolved ? "text-warning-foreground" : "text-muted-foreground"}`}
          >
            {t(
              `${mapping.preview.length} codes, ${unresolved} unresolved`,
              `${mapping.preview.length} 件、未解決 ${unresolved} 件`
            )}
          </span>
        </div>
        <div className="max-h-64 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-muted text-left font-mono text-[10px] uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
              <tr>
                <th className="px-2 py-2">{t("Raw Code", "元コード")}</th>
                <th className="px-2 py-2">{t("Count", "件数")}</th>
                <th className="px-2 py-2">{t("Assigned Category", "割り当てカテゴリ")}</th>
              </tr>
            </thead>
            <tbody>
              {mapping.preview.map((row) => (
                <tr
                  key={row.code}
                  className={`border-t border-border ${row.unresolved ? "bg-warning/10" : "bg-card"}`}
                >
                  <td className="px-2 py-2 font-mono text-xs">{row.code}</td>
                  <td className="px-2 py-2">{row.count}</td>
                  <td className="px-2 py-2">
                    <Select
                      value={row.resolved_category}
                      disabled={saving || row.code === "(empty)"}
                      onValueChange={(value) => updateCodeCategory(row.code, value)}
                    >
                      <SelectTrigger
                        className="h-8"
                        aria-label={t(`Category for ${row.code}`, `${row.code} のカテゴリ`)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {categoryOptions.map((category) => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              ))}
              {mapping.preview.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-sm text-muted-foreground" colSpan={3}>
                    {t(
                      "Select a code column to generate coverage preview.",
                      "コード列を選択するとカバレッジプレビューが表示されます。"
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border bg-muted px-3 py-2 text-xs leading-4 text-muted-foreground">
          {t(
            "A category selection applies to all units with the same raw code value.",
            "カテゴリを選択すると、同じ元コードを持つすべてのユニットに適用されます。"
          )}
        </p>
      </div>

    </section>
  );
}
