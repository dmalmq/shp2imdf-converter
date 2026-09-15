import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";

/** Radix Select has no empty-string value, so "no filter" needs a sentinel. */
const ANY = "__any__";

export type ReviewFilters = {
  type?: string;
  level?: string;
  category?: string;
  status?: string;
  search?: string;
};

type Props = {
  filters: ReviewFilters;
  featureTypes: string[];
  levels: Array<{ id: string; label: string }>;
  categories: string[];
  onChange: (next: ReviewFilters) => void;
};

export function activeFilterCount(filters: ReviewFilters): number {
  return [filters.type, filters.level, filters.category, filters.status, filters.search].filter(
    (value) => Boolean(value && value.trim())
  ).length;
}

function FilterSelect({
  label,
  value,
  options,
  anyLabel,
  onChange
}: {
  label: string;
  value: string | undefined;
  options: Array<{ id: string; label: string }>;
  anyLabel: string;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Select
          value={value || ANY}
          onValueChange={(next) => onChange(next === ANY ? undefined : next)}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{anyLabel}</SelectItem>
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

/**
 * Narrows which features the table and the sidebar list show.
 *
 * The status filter is also what validation sets for you: finishing a run with
 * errors leaves `status: error` here, which is why clearing has to be one
 * obvious control rather than five separate "All"s.
 */
export function FilterBar({ filters, featureTypes, levels, categories, onChange }: Props) {
  const { t } = useUiLanguage();
  const active = activeFilterCount(filters);
  const anyLabel = t("Any", "すべて");

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <FilterSelect
          label={t("Type", "種別")}
          value={filters.type}
          anyLabel={anyLabel}
          options={featureTypes.map((item) => ({ id: item, label: item }))}
          onChange={(type) => onChange({ ...filters, type })}
        />
        <FilterSelect
          label={t("Level", "レベル")}
          value={filters.level}
          anyLabel={anyLabel}
          options={levels}
          onChange={(level) => onChange({ ...filters, level })}
        />
        <FilterSelect
          label={t("Category", "カテゴリ")}
          value={filters.category}
          anyLabel={anyLabel}
          options={categories.map((item) => ({ id: item, label: item }))}
          onChange={(category) => onChange({ ...filters, category })}
        />
        <FilterSelect
          label={t("Status", "ステータス")}
          value={filters.status}
          anyLabel={anyLabel}
          options={[
            { id: "mapped", label: t("Mapped", "mapped") },
            { id: "unspecified", label: t("Unspecified", "unspecified") },
            { id: "warning", label: t("Warning", "warning") },
            { id: "error", label: t("Error", "error") }
          ]}
          onChange={(status) => onChange({ ...filters, status })}
        />
        <Field label={t("Search", "検索")}>
          {(id) => (
            <Input
              id={id}
              type="search"
              value={filters.search ?? ""}
              placeholder={t("Name or attribute", "名称または属性")}
              onChange={(event) =>
                onChange({ ...filters, search: event.target.value || undefined })
              }
            />
          )}
        </Field>
      </div>

      {active > 0 ? (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
            {t(`${active} filters active`, `フィルター ${active} 件`)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-1.5 py-0.5 text-xs font-normal"
            onClick={() => onChange({})}
          >
            {t("Clear all", "すべて解除")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
