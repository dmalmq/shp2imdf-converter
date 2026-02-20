import { useEffect, useMemo, useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { type ReviewFeature, type ReviewIssue, featureName } from "./types";


const NON_EDITABLE_KEYS = new Set(["metadata", "issues", "status", "source_file", "display_point"]);

type Props = {
  feature: ReviewFeature | null;
  language: string;
  levelOptions: Array<{ id: string; label: string }>;
  addressOptions: Array<{ id: string; label: string }>;
  validationIssues: ReviewIssue[];
  autoFixing: boolean;
  onSave: (featureId: string, properties: Record<string, unknown>) => void;
  onDelete: (featureId: string) => void;
  onAutoFixSafe: () => void;
};


function asLabelText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const candidate = Object.values(value as Record<string, unknown>).find((item) => typeof item === "string");
    return typeof candidate === "string" ? candidate : "";
  }
  return "";
}


function toStringValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(",");
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "";
}


function normalizeIssues(value: unknown): ReviewIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: ReviewIssue[] = [];
  value.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.check !== "string" ||
      typeof candidate.message !== "string" ||
      (candidate.severity !== "error" && candidate.severity !== "warning")
    ) {
      return;
    }
    normalized.push({
      feature_id: typeof candidate.feature_id === "string" ? candidate.feature_id : null,
      related_feature_id: typeof candidate.related_feature_id === "string" ? candidate.related_feature_id : null,
      check: candidate.check,
      message: candidate.message,
      severity: candidate.severity,
      auto_fixable: candidate.auto_fixable === true,
      fix_description: typeof candidate.fix_description === "string" ? candidate.fix_description : null,
      overlap_geometry:
        candidate.overlap_geometry && typeof candidate.overlap_geometry === "object" && !Array.isArray(candidate.overlap_geometry)
          ? (candidate.overlap_geometry as Record<string, unknown>)
          : null
    });
  });
  return normalized;
}


export function PropertiesPanel({
  feature,
  language,
  levelOptions,
  addressOptions,
  validationIssues,
  autoFixing,
  onSave,
  onDelete,
  onAutoFixSafe
}: Props) {
  const { t } = useUiLanguage();
  const [form, setForm] = useState<Record<string, unknown>>({});

  useEffect(() => {
    setForm(feature?.properties ? { ...feature.properties } : {});
  }, [feature]);

  const issues = useMemo(() => {
    if (!feature) {
      return [] as ReviewIssue[];
    }
    if (validationIssues.length > 0) {
      return validationIssues;
    }
    return normalizeIssues(feature.properties.issues);
  }, [feature, validationIssues]);

  const editableKeys = useMemo(() => {
    if (!feature) {
      return [] as string[];
    }
    return Object.keys(feature.properties)
      .filter((key) => !NON_EDITABLE_KEYS.has(key))
      .sort((a, b) => a.localeCompare(b));
  }, [feature]);

  if (!feature) {
    return (
      <div className="rounded border bg-white p-3 text-sm text-slate-600">
        {t("Select a feature to inspect/edit its properties.", "フィーチャーを選択してプロパティを確認・編集してください。")}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded border bg-white p-3">
      <div>
        <h3 className="text-sm font-semibold">{t("Properties", "プロパティ")}</h3>
        <p className="text-xs text-slate-600">
          {feature.feature_type} <span className="font-mono">{feature.id.slice(0, 8)}</span>
        </p>
      </div>

      {issues.length > 0 ? (
        <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          {issues.map((item, index) => (
            <div key={`${item.check}-${index}`} className="rounded border border-amber-200 bg-white p-2">
              <p className="font-medium">
                [{item.severity}] {item.check}
              </p>
              <p>{item.message}</p>
              {item.fix_description ? <p className="text-amber-700">{item.fix_description}</p> : null}
              {item.auto_fixable ? (
                <button
                  type="button"
                  className="mt-1 rounded border border-amber-300 px-2 py-0.5 text-[11px]"
                  onClick={onAutoFixSafe}
                  disabled={autoFixing}
                >
                  {autoFixing ? t("Applying...", "適用中...") : t("Auto-fix", "自動修正")}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
          {t("No validation issues loaded yet (Phase 5 integration).", "検証結果はまだ読み込まれていません（Phase 5 連携）。")}
        </div>
      )}

      <div className="grid gap-2">
        {editableKeys.map((key) => {
          const value = form[key];

          if (key === "name" || key === "alt_name") {
            return (
              <label key={key} className="text-xs">
                <span className="mb-1 block text-slate-600">{key}</span>
                <input
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={asLabelText(value)}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      [key]: event.target.value ? { [language]: event.target.value } : null
                    }))
                  }
                />
              </label>
            );
          }

          if (key === "level_id") {
            return (
              <label key={key} className="text-xs">
                <span className="mb-1 block text-slate-600">level_id</span>
                <select
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      level_id: event.target.value || null
                    }))
                  }
                >
                  <option value="">{t("(none)", "（なし）")}</option>
                  {levelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }

          if (key === "address_id") {
            return (
              <label key={key} className="text-xs">
                <span className="mb-1 block text-slate-600">address_id</span>
                <select
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      address_id: event.target.value || null
                    }))
                  }
                >
                  <option value="">{t("(none)", "（なし）")}</option>
                  {addressOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }

          if (key === "building_ids") {
            return (
              <label key={key} className="text-xs">
                <span className="mb-1 block text-slate-600">building_ids</span>
                <input
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={toStringValue(value)}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      building_ids: event.target.value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean)
                    }))
                  }
                />
              </label>
            );
          }

          if (typeof value === "boolean") {
            return (
              <label key={key} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      [key]: event.target.checked
                    }))
                  }
                />
                <span>{key}</span>
              </label>
            );
          }

          if (typeof value === "number") {
            return (
              <label key={key} className="text-xs">
                <span className="mb-1 block text-slate-600">{key}</span>
                <input
                  type="number"
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={value}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      [key]: Number(event.target.value)
                    }))
                  }
                />
              </label>
            );
          }

          return (
            <label key={key} className="text-xs">
              <span className="mb-1 block text-slate-600">{key}</span>
              <input
                className="w-full rounded border px-2 py-1.5 text-sm"
                value={toStringValue(value)}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    [key]: event.target.value || null
                  }))
                }
              />
            </label>
          );
        })}
      </div>

      <div className="text-xs text-slate-600">
        {t("Name preview", "名称プレビュー")}: <span className="font-medium">{featureName({ ...feature, properties: form }) || "-"}</span>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white"
          onClick={() => onSave(feature.id, form)}
        >
          {t("Save Changes", "変更を保存")}
        </button>
        <button
          type="button"
          className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700"
          onClick={() => onDelete(feature.id)}
        >
          {t("Delete Feature", "フィーチャーを削除")}
        </button>
      </div>
    </div>
  );
}
