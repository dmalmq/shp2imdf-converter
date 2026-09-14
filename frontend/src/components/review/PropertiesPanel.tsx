import { useEffect, useMemo, useState } from "react";

import type { FeatureTypeOption } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  categoryOptionsFor,
  compatibleFeatureTypes,
  geometryKindOf
} from "./featureTypeOptions";
import { type ReviewFeature, featureName } from "./types";


const NON_EDITABLE_KEYS = new Set(["metadata", "issues", "status", "source_file", "display_point"]);

type Props = {
  feature: ReviewFeature | null;
  language: string;
  levelOptions: Array<{ id: string; label: string }>;
  addressOptions: Array<{ id: string; label: string }>;
  featureTypes: FeatureTypeOption[];
  onSave: (featureId: string, properties: Record<string, unknown>, featureType?: string) => void;
  onDelete: (featureId: string) => void;
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


export function PropertiesPanel({
  feature,
  language,
  levelOptions,
  addressOptions,
  featureTypes,
  onSave,
  onDelete
}: Props) {
  const { t } = useUiLanguage();
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [pendingType, setPendingType] = useState(feature?.feature_type ?? "");

  useEffect(() => {
    setForm(feature?.properties ? { ...feature.properties } : {});
    setPendingType(feature?.feature_type ?? "");
  }, [feature]);

  const editableKeys = useMemo(() => {
    if (!feature) {
      return [] as string[];
    }
    const keys = Object.keys(feature.properties).filter((key) => !NON_EDITABLE_KEYS.has(key));
    const pending = featureTypes.find((option) => option.feature_type === pendingType);
    if (pending?.has_category && !keys.includes("category")) {
      keys.push("category");
    }
    return keys.sort((a, b) => a.localeCompare(b));
  }, [feature, featureTypes, pendingType]);

  if (!feature) {
    return (
      <div className="rounded border bg-white p-3 text-sm text-slate-600">
        {t("Select a feature to inspect/edit its properties.", "フィーチャーを選択してプロパティを確認・編集してください。")}
      </div>
    );
  }

  const compatibleTypes = compatibleFeatureTypes(featureTypes, feature.geometry);
  const typeOptions = compatibleTypes.some((option) => option.feature_type === feature.feature_type)
    ? compatibleTypes
    : [
        {
          feature_type: feature.feature_type,
          geometry: geometryKindOf(feature.geometry),
          has_category: false,
          categories: null,
          default_category: null
        },
        ...compatibleTypes
      ];

  return (
    <div className="space-y-3 rounded border bg-white p-3">
      <div>
        <h3 className="text-sm font-semibold">{t("Properties", "プロパティ")}</h3>
        <label className="mt-1 block text-xs">
          <span className="mb-1 block text-slate-600">{t("Feature type", "フィーチャー種別")}</span>
          <select
            className="w-full rounded border px-2 py-1.5 text-sm"
            value={pendingType}
            onChange={(event) => {
              const nextType = event.target.value;
              setPendingType(nextType);
              const nextOption = featureTypes.find((option) => option.feature_type === nextType);
              const categories = nextOption?.categories ?? null;
              if (categories === null) {
                return;
              }
              setForm((prev) => {
                const current = typeof prev.category === "string" ? prev.category : "";
                if (current && categories.includes(current)) {
                  return prev;
                }
                return { ...prev, category: nextOption?.default_category ?? null };
              });
            }}
          >
            {typeOptions.map((option) => (
              <option key={option.feature_type} value={option.feature_type}>
                {option.feature_type}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-slate-600">
          <span className="font-mono">{feature.id.slice(0, 8)}</span>
        </p>
        {pendingType !== feature.feature_type ? (
          <p className="mt-1 text-xs text-slate-600">
            {t(
              `Saving converts this feature to ${pendingType} and drops properties that type does not use.`,
              `保存すると ${pendingType} に変換され、この種別で使用しないプロパティは削除されます。`
            )}
          </p>
        ) : null}
      </div>

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

          if (key === "category") {
            const categories = categoryOptionsFor(featureTypes, pendingType);
            if (categories !== null) {
              const current = typeof value === "string" ? value : "";
              const options = current && !categories.includes(current) ? [current, ...categories] : categories;
              return (
                <label key={key} className="text-xs">
                  <span className="mb-1 block text-slate-600">category</span>
                  <select
                    className="w-full rounded border px-2 py-1.5 text-sm"
                    value={current}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        category: event.target.value || null
                      }))
                    }
                  >
                    <option value="">{t("(none)", "（なし）")}</option>
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            return (
              <label key={key} className="text-xs">
                <span className="mb-1 block text-slate-600">category</span>
                <input
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={toStringValue(value)}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      category: event.target.value || null
                    }))
                  }
                />
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
          onClick={() => onSave(feature.id, form, pendingType !== feature.feature_type ? pendingType : undefined)}
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
