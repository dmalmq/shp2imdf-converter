import { useUiLanguage } from "../../hooks/useUiLanguage";

type Filters = {
  type?: string;
  level?: string;
  category?: string;
  status?: string;
  search?: string;
};

type Props = {
  filters: Filters;
  featureTypes: string[];
  levels: Array<{ id: string; label: string }>;
  categories: string[];
  onChange: (next: Filters) => void;
};


export function FilterBar({ filters, featureTypes, levels, categories, onChange }: Props) {
  const { t } = useUiLanguage();

  return (
    <div className="grid gap-2 rounded border bg-white p-3 xl:grid-cols-5">
      <label className="text-xs">
        <span className="mb-1 block text-slate-600">{t("Type", "種別")}</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.type ?? ""}
          onChange={(event) => onChange({ ...filters, type: event.target.value || undefined })}
        >
          <option value="">{t("All", "すべて")}</option>
          {featureTypes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">{t("Level", "レベル")}</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.level ?? ""}
          onChange={(event) => onChange({ ...filters, level: event.target.value || undefined })}
        >
          <option value="">{t("All", "すべて")}</option>
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">{t("Category", "カテゴリ")}</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.category ?? ""}
          onChange={(event) => onChange({ ...filters, category: event.target.value || undefined })}
        >
          <option value="">{t("All", "すべて")}</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">{t("Status", "ステータス")}</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.status ?? ""}
          onChange={(event) => onChange({ ...filters, status: event.target.value || undefined })}
        >
          <option value="">{t("All", "すべて")}</option>
          <option value="mapped">{t("mapped", "mapped")}</option>
          <option value="unspecified">{t("unspecified", "unspecified")}</option>
          <option value="warning">{t("warning", "warning")}</option>
          <option value="error">{t("error", "error")}</option>
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">{t("Search", "検索")}</span>
        <input
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.search ?? ""}
          onChange={(event) => onChange({ ...filters, search: event.target.value || undefined })}
          placeholder={t("Name or attribute", "名称または属性")}
        />
      </label>
    </div>
  );
}
