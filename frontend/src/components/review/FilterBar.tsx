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
  return (
    <div className="grid gap-2 rounded border bg-white p-3 xl:grid-cols-5">
      <label className="text-xs">
        <span className="mb-1 block text-slate-600">Type</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.type ?? ""}
          onChange={(event) => onChange({ ...filters, type: event.target.value || undefined })}
        >
          <option value="">All</option>
          {featureTypes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">Level</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.level ?? ""}
          onChange={(event) => onChange({ ...filters, level: event.target.value || undefined })}
        >
          <option value="">All</option>
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">Category</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.category ?? ""}
          onChange={(event) => onChange({ ...filters, category: event.target.value || undefined })}
        >
          <option value="">All</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">Status</span>
        <select
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.status ?? ""}
          onChange={(event) => onChange({ ...filters, status: event.target.value || undefined })}
        >
          <option value="">All</option>
          <option value="mapped">mapped</option>
          <option value="unspecified">unspecified</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-1 block text-slate-600">Search</span>
        <input
          className="w-full rounded border px-2 py-1.5 text-sm"
          value={filters.search ?? ""}
          onChange={(event) => onChange({ ...filters, search: event.target.value || undefined })}
          placeholder="Name or attribute"
        />
      </label>
    </div>
  );
}

