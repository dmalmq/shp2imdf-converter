import { useMemo, useRef, useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { EmptyState } from "../shared/EmptyState";
import { FeatureTypeIcon } from "../ui";
import { DEFAULT_LOCATED_FEATURE_ORDER, featureName, type ReviewFeature, type ReviewIssue } from "./types";


type Props = {
  features: ReviewFeature[];
  selectedFeatureIds: string[];
  validationIssues: ReviewIssue[];
  onSelectFeature: (id: string, multi?: boolean) => void;
  onSelectionChange?: (ids: string[]) => void;
};


function statusForFeature(
  featureId: string,
  errorIds: Set<string>,
  warningIds: Set<string>
): "error" | "warning" | "ok" {
  if (errorIds.has(featureId)) return "error";
  if (warningIds.has(featureId)) return "warning";
  return "ok";
}

const STATUS_DOT: Record<string, string> = {
  error: "bg-[var(--color-error)]",
  warning: "bg-[var(--color-warning)]",
  ok: "bg-[var(--color-success)]"
};

type FeatureGroup = {
  type: string;
  features: ReviewFeature[];
};

const TYPE_ORDER = new Map(DEFAULT_LOCATED_FEATURE_ORDER.map((t, i) => [t, i]));

function groupByType(features: ReviewFeature[]): FeatureGroup[] {
  const map = new Map<string, ReviewFeature[]>();
  for (const f of features) {
    const list = map.get(f.feature_type);
    if (list) {
      list.push(f);
    } else {
      map.set(f.feature_type, [f]);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      const oa = TYPE_ORDER.get(a) ?? 999;
      const ob = TYPE_ORDER.get(b) ?? 999;
      return oa !== ob ? oa - ob : a.localeCompare(b);
    })
    .map(([type, features]) => ({ type, features }));
}


export function FeatureList({
  features,
  selectedFeatureIds,
  validationIssues,
  onSelectFeature,
  onSelectionChange
}: Props) {
  const { t } = useUiLanguage();
  const selectedSet = useMemo(() => new Set(selectedFeatureIds), [selectedFeatureIds]);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(features.map((f) => f.feature_type)));
  const listRef = useRef<HTMLDivElement>(null);

  const errorIds = useMemo(
    () => new Set(validationIssues.filter((i) => i.severity === "error" && i.feature_id).map((i) => i.feature_id!)),
    [validationIssues]
  );
  const warningIds = useMemo(
    () => new Set(validationIssues.filter((i) => i.severity === "warning" && i.feature_id).map((i) => i.feature_id!)),
    [validationIssues]
  );

  const featureTypes = useMemo(
    () => [...new Set(features.map((f) => f.feature_type))].sort(),
    [features]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return features.filter((f) => {
      if (typeFilter && f.feature_type !== typeFilter) return false;
      if (!q) return true;
      const name = featureName(f).toLowerCase();
      return name.includes(q) || f.id.toLowerCase().includes(q) || f.feature_type.includes(q);
    });
  }, [features, search, typeFilter]);

  const groups = useMemo(() => groupByType(filtered), [filtered]);

  // Flat list of visible (non-collapsed) feature ids for shift-click range selection
  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of groups) {
      if (!collapsed.has(group.type)) {
        for (const f of group.features) {
          ids.push(f.id);
        }
      }
    }
    return ids;
  }, [groups, collapsed]);

  const setSelection = (ids: string[]) => {
    if (onSelectionChange) {
      onSelectionChange(ids);
      return;
    }
    const nextSet = new Set(ids);
    const delta = new Set<string>();
    selectedFeatureIds.forEach((id) => { if (!nextSet.has(id)) delta.add(id); });
    ids.forEach((id) => { if (!selectedSet.has(id)) delta.add(id); });
    delta.forEach((id) => onSelectFeature(id, true));
  };

  const handleClick = (id: string, event: React.MouseEvent) => {
    if (event.shiftKey && lastClickedId) {
      const from = visibleIds.indexOf(lastClickedId);
      const to = visibleIds.indexOf(id);
      if (from !== -1 && to !== -1) {
        const start = Math.min(from, to);
        const end = Math.max(from, to);
        const range = visibleIds.slice(start, end + 1);
        const next = new Set(selectedFeatureIds);
        range.forEach((rid) => next.add(rid));
        setSelection([...next]);
        setLastClickedId(id);
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      if (selectedSet.has(id)) {
        setSelection(selectedFeatureIds.filter((sid) => sid !== id));
      } else {
        setSelection([...selectedFeatureIds, id]);
      }
    } else {
      onSelectFeature(id, false);
    }
    setLastClickedId(id);
  };

  const toggleCollapse = (type: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
        <input
          type="text"
          className="h-7 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]/20"
          placeholder={t("Search...", "検索...")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-xs focus:border-[var(--color-primary)] focus:outline-none"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">{t("All types", "すべて")}</option>
          {featureTypes.map((ft) => (
            <option key={ft} value={ft}>{ft}</option>
          ))}
        </select>
      </div>

      <div className="px-3 py-1.5 text-[11px] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
        {filtered.length} {t("features", "件")}
        {selectedFeatureIds.length > 0 ? ` · ${selectedFeatureIds.length} ${t("selected", "選択中")}` : ""}
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.type);
          const groupErrors = group.features.filter((f) => errorIds.has(f.id)).length;
          const groupWarnings = group.features.filter((f) => warningIds.has(f.id)).length;

          return (
            <div key={group.type}>
              {/* Group header */}
              <div
                className="sticky top-0 z-[1] flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1.5 cursor-pointer select-none text-xs font-medium text-[var(--color-text)]"
                onClick={() => toggleCollapse(group.type)}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  className={`shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  fill="currentColor"
                >
                  <path d="M3 1l4 4-4 4z" />
                </svg>
                <FeatureTypeIcon featureType={group.type} size="sm" />
                <span className="capitalize">{group.type}</span>
                <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{group.features.length}</span>
                {groupErrors > 0 ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-error)]" title={`${groupErrors} errors`} />
                ) : groupWarnings > 0 ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-warning)]" title={`${groupWarnings} warnings`} />
                ) : null}
              </div>

              {/* Feature rows */}
              {!isCollapsed && group.features.map((feature) => {
                const selected = selectedSet.has(feature.id);
                const name = featureName(feature);
                const status = statusForFeature(feature.id, errorIds, warningIds);
                const category = typeof feature.properties.category === "string" ? feature.properties.category : "";

                return (
                  <div
                    key={feature.id}
                    className={[
                      "flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b border-[var(--color-border)]/50 text-xs transition-colors pl-7",
                      selected
                        ? "bg-[var(--color-primary-muted)] border-l-2 border-l-[var(--color-primary)]"
                        : "hover:bg-[var(--color-surface-muted)]"
                    ].join(" ")}
                    onClick={(e) => handleClick(feature.id, e)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-[var(--color-text)]">
                        {name || <span className="font-mono text-[var(--color-text-muted)]">{feature.id.slice(0, 8)}</span>}
                      </div>
                      {category ? (
                        <div className="truncate text-[10px] text-[var(--color-text-muted)]">{category}</div>
                      ) : null}
                    </div>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
                  </div>
                );
              })}
            </div>
          );
        })}

        {filtered.length === 0 ? (
          <EmptyState
            icon="search"
            title={t("No features found", "フィーチャーが見つかりません")}
            description={features.length === 0
              ? t("Generate IMDF features from the Configure page first.", "まず設定ページから IMDF フィーチャーを生成してください。")
              : t("No features match the current filters.", "現在のフィルターに一致するフィーチャーがありません。")}
          />
        ) : null}
      </div>
    </div>
  );
}
