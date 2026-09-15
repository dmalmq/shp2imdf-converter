import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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

type Props = {
  feature: ReviewFeature | null;
  language: string;
  levelOptions: Array<{ id: string; label: string }>;
  addressOptions: Array<{ id: string; label: string }>;
  onSave: (featureId: string, properties: Record<string, unknown>) => void;
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
  onSave,
  onDelete
}: Props) {
  const { t } = useUiLanguage();
  const [form, setForm] = useState<Record<string, unknown>>({});

  useEffect(() => {
    setForm(feature?.properties ? { ...feature.properties } : {});
  }, [feature]);

  const allKeys = useMemo(() => {
    if (!feature) {
      return [] as string[];
    }
    return Object.keys(feature.properties)
      .filter((key) => !NON_EDITABLE_KEYS.has(key))
      .sort((a, b) => a.localeCompare(b));
  }, [feature]);

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
      return (
        <Field key={key} label={key}>
          {(id) => (
            <Input
              id={id}
              value={asLabelText(value)}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  [key]: event.target.value ? { [language]: event.target.value } : null
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

  return (
    <div className="flex flex-col gap-4">
      <p className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
        {feature.feature_type} · {feature.id.slice(0, 8)}
      </p>

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
          {featureName({ ...feature, properties: form }) || "-"}
        </span>
      </p>

      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(feature.id, form)}>
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
