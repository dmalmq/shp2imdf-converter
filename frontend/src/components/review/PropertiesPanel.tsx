import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { FeatureTypeOption } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";
import {
  categoryOptionsFor,
  compatibleFeatureTypes,
  geometryKindOf
} from "./featureTypeOptions";
import { labelLanguage, labelText, setLabelText } from "./labels";
import { type ReviewFeature, featureName } from "./types";


const NON_EDITABLE_KEYS = new Set(["metadata", "issues", "status", "source_file", "display_point"]);

/** Radix Select has no empty-string value, so "unset" needs a sentinel. */
const UNSET = "__none__";

/**
 * Keys the importer fills in and nobody edits by hand. They were mixed into
 * the same alphabetical list as name and category, so the two fields you
 * actually came to change sat between `restriction` and `source_feature_ref`.
 */
const PROVENANCE_KEYS = new Set([
  "source_feature_ref",
  "source_part_index",
  "source_row_index",
  "source_layer",
  "source_stem"
]);

const NATIVE_SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

type Props = {
  feature: ReviewFeature | null;
  language: string;
  levelOptions: Array<{ id: string; label: string }>;
  addressOptions: Array<{ id: string; label: string }>;
  featureTypes: FeatureTypeOption[];
  onSave: (featureId: string, properties: Record<string, unknown>, featureType?: string) => void;
  onDelete: (featureId: string) => void;
};


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

  const allKeys = useMemo(() => {
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

  const editableKeys = useMemo(
    () => allKeys.filter((key) => !PROVENANCE_KEYS.has(key)),
    [allKeys]
  );
  const provenanceKeys = useMemo(
    () => allKeys.filter((key) => PROVENANCE_KEYS.has(key)),
    [allKeys]
  );

  if (!feature) {
    return (
      <p className="text-[13px] leading-[18px] text-muted-foreground">
        {t(
          "Select a feature to inspect or edit its properties.",
          "フィーチャーを選択するとプロパティを編集できます。"
        )}
      </p>
    );
  }

  const renderField = (key: string) => {
    const value = form[key];

    if (key === "name" || key === "alt_name") {
      const editLanguage = labelLanguage(feature.properties[key], language);
      return (
        <Field
          key={key}
          label={key}
          hint={
            editLanguage !== language
              ? t(
                  `Editing the "${editLanguage}" label (no "${language}" label yet)`,
                  `「${editLanguage}」の名称を編集中（「${language}」は未設定）`
                )
              : undefined
          }
        >
          {(id) => (
            <Input
              id={id}
              value={labelText(value, editLanguage)}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  [key]: setLabelText(prev[key], editLanguage, event.target.value)
                }))
              }
            />
          )}
        </Field>
      );
    }

    if (key === "level_id" || key === "address_id") {
      const options = key === "level_id" ? levelOptions : addressOptions;
      return (
        <Field key={key} label={key}>
          {(id) => (
            <Select
              value={typeof value === "string" && value ? value : UNSET}
              onValueChange={(next) =>
                setForm((prev) => ({ ...prev, [key]: next === UNSET ? null : next }))
              }
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>{t("Not set", "未設定")}</SelectItem>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      );
    }

    if (key === "category") {
      const categories = categoryOptionsFor(featureTypes, pendingType);
      if (categories !== null) {
        const current = typeof value === "string" ? value : "";
        const options =
          current && !categories.includes(current) ? [current, ...categories] : categories;
        return (
          <Field key={key} label="category">
            {(id) => (
              <select
                id={id}
                className={NATIVE_SELECT_CLASS}
                value={current}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, category: event.target.value || null }))
                }
              >
                <option value="">{t("(none)", "（なし）")}</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )}
          </Field>
        );
      }
    }

    if (key === "building_ids") {
      return (
        <Field key={key} label={key} hint={t("Comma-separated", "カンマ区切り")}>
          {(id) => (
            <Input
              id={id}
              className="font-mono text-xs"
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
          )}
        </Field>
      );
    }

    if (typeof value === "boolean") {
      return (
        <label
          key={key}
          className="flex cursor-pointer items-center gap-2 py-1 text-[13px] leading-[18px] text-foreground"
        >
          <Checkbox
            checked={value}
            onCheckedChange={(checked) => setForm((prev) => ({ ...prev, [key]: checked === true }))}
          />
          <span>{key}</span>
        </label>
      );
    }

    if (typeof value === "number") {
      return (
        <Field key={key} label={key}>
          {(id) => (
            <Input
              id={id}
              type="number"
              value={value}
              onChange={(event) => setForm((prev) => ({ ...prev, [key]: Number(event.target.value) }))}
            />
          )}
        </Field>
      );
    }

    return (
      <Field key={key} label={key}>
        {(id) => (
          <Input
            id={id}
            value={toStringValue(value)}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, [key]: event.target.value || null }))
            }
          />
        )}
      </Field>
    );
  };

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
    <div className="flex flex-col gap-4">
      <p className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
        {feature.feature_type} · {feature.id.slice(0, 8)}
      </p>

      <Field label={t("Feature type", "フィーチャー種別")}>
        {(id) => (
          <select
            id={id}
            className={NATIVE_SELECT_CLASS}
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
        )}
      </Field>
      {pendingType !== feature.feature_type ? (
        <p className="text-xs leading-4 text-muted-foreground">
          {t(
            `Saving converts this feature to ${pendingType} and drops properties that type does not use.`,
            `保存すると ${pendingType} に変換され、この種別で使用しないプロパティは削除されます。`
          )}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">{editableKeys.map(renderField)}</div>

      {provenanceKeys.length > 0 ? (
        <details className="group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium leading-[18px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {t("Where this came from", "元データ")}
          </summary>
          <div className="mt-3 flex flex-col gap-3">{provenanceKeys.map(renderField)}</div>
        </details>
      ) : null}

      <p className="text-xs leading-4 text-muted-foreground">
        {t("Name preview", "名称プレビュー")}:{" "}
        <span className="font-medium text-foreground">
          {featureName({ ...feature, properties: form }, language) || "-"}
        </span>
      </p>

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() =>
            onSave(
              feature.id,
              form,
              pendingType !== feature.feature_type ? pendingType : undefined
            )
          }
        >
          {t("Save changes", "変更を保存")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onDelete(feature.id)}
        >
          {t("Delete feature", "フィーチャーを削除")}
        </Button>
      </div>
    </div>
  );
}
