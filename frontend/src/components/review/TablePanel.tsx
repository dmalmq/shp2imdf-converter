import { useMemo, useState } from "react";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from "@tanstack/react-table";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { EmptyState } from "../shared/EmptyState";
import { FeatureTypeIcon } from "../shared/FeatureTypeIcon";
import { Badge, Checkbox } from "../ui";
import { featureName, type ReviewFeature } from "./types";


type Props = {
  features: ReviewFeature[];
  selectedFeatureIds: string[];
  onSelectFeature: (id: string, multi?: boolean) => void;
  onSelectionChange?: (ids: string[]) => void;
};


function categoryValue(feature: ReviewFeature): string {
  const value = feature.properties.category;
  return typeof value === "string" ? value : "";
}


function levelValue(feature: ReviewFeature): string {
  if (feature.feature_type === "level") {
    return feature.id;
  }
  const levelId = feature.properties.level_id;
  return typeof levelId === "string" ? levelId : "";
}


function statusValue(feature: ReviewFeature): string {
  const value = feature.properties.status;
  return typeof value === "string" ? value : "mapped";
}


export function TablePanel({ features, selectedFeatureIds, onSelectFeature, onSelectionChange }: Props) {
  const { t } = useUiLanguage();
  const selectedSet = useMemo(() => new Set(selectedFeatureIds), [selectedFeatureIds]);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  const visibleIds = useMemo(() => features.map((item) => item.id), [features]);
  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds]);
  const selectedVisibleCount = useMemo(
    () => visibleIds.reduce((count, id) => (selectedSet.has(id) ? count + 1 : count), 0),
    [selectedSet, visibleIds]
  );
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const indexById = useMemo(() => {
    const mapped = new Map<string, number>();
    visibleIds.forEach((id, index) => {
      mapped.set(id, index);
    });
    return mapped;
  }, [visibleIds]);

  const setSelection = (ids: string[]) => {
    if (onSelectionChange) {
      onSelectionChange(ids);
      return;
    }

    const nextSet = new Set(ids);
    const delta = new Set<string>();
    selectedFeatureIds.forEach((id) => {
      if (!nextSet.has(id)) {
        delta.add(id);
      }
    });
    ids.forEach((id) => {
      if (!selectedSet.has(id)) {
        delta.add(id);
      }
    });
    delta.forEach((id) => {
      onSelectFeature(id, true);
    });
  };

  const toggleSingle = (id: string) => {
    if (selectedSet.has(id)) {
      setSelection(selectedFeatureIds.filter((item) => item !== id));
    } else {
      setSelection([...selectedFeatureIds, id]);
    }
    setLastSelectedId(id);
  };

  const toggleRange = (id: string) => {
    const currentIndex = indexById.get(id);
    const anchorIndex = lastSelectedId ? indexById.get(lastSelectedId) : undefined;
    if (currentIndex === undefined || anchorIndex === undefined) {
      toggleSingle(id);
      return;
    }

    const from = Math.min(anchorIndex, currentIndex);
    const to = Math.max(anchorIndex, currentIndex);
    const rangeIds = visibleIds.slice(from, to + 1);
    const shouldSelect = !selectedSet.has(id);
    const next = new Set(selectedFeatureIds);

    rangeIds.forEach((featureId) => {
      if (shouldSelect) {
        next.add(featureId);
      } else {
        next.delete(featureId);
      }
    });

    setSelection([...next]);
    setLastSelectedId(id);
  };

  const handleRowSelection = (id: string, shiftKey: boolean) => {
    if (shiftKey) {
      toggleRange(id);
      return;
    }
    toggleSingle(id);
  };

  const toggleAllVisible = (checked: boolean) => {
    if (checked) {
      const next = [...selectedFeatureIds];
      visibleIds.forEach((id) => {
        if (!selectedSet.has(id)) {
          next.push(id);
        }
      });
      setSelection(next);
      if (visibleIds.length > 0) {
        setLastSelectedId(visibleIds[visibleIds.length - 1]);
      }
      return;
    }

    setSelection(selectedFeatureIds.filter((id) => !visibleSet.has(id)));
  };

  const columns: ColumnDef<ReviewFeature>[] = [
    {
      id: "select",
      header: () => (
        <Checkbox
          checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
          disabled={visibleIds.length === 0}
          aria-label={t("Select all visible rows", "表示中の行をすべて選択")}
          onCheckedChange={(next) => toggleAllVisible(next === true)}
          onClick={(event) => event.stopPropagation()}
        />
      ),
      cell: ({ row }) => {
        const id = row.original.id;
        return (
          // Shift-click extends the selection, and `onCheckedChange` does not
          // carry the modifier keys — so the click event is what decides.
          <Checkbox
            checked={selectedSet.has(id)}
            aria-label={featureName(row.original) || id}
            onClick={(event) => {
              event.stopPropagation();
              handleRowSelection(id, event.shiftKey);
            }}
          />
        );
      }
    },
    {
      accessorKey: "id",
      header: t("ID", "ID"),
      cell: ({ getValue }) => {
        const value = String(getValue());
        return <span className="font-mono text-xs">{value.slice(0, 8)}</span>;
      }
    },
    {
      id: "name",
      header: t("Name", "名称"),
      cell: ({ row }) => featureName(row.original) || "-"
    },
    {
      accessorKey: "feature_type",
      header: t("Type", "種別"),
      cell: ({ getValue }) => (
        <span className="flex items-center gap-1.5">
          <FeatureTypeIcon featureType={String(getValue())} size="sm" />
          <span className="capitalize">{String(getValue())}</span>
        </span>
      )
    },
    {
      id: "category",
      header: t("Category", "カテゴリ"),
      cell: ({ row }) => categoryValue(row.original) || "-"
    },
    {
      id: "level",
      header: t("Level", "レベル"),
      cell: ({ row }) => {
        const value = levelValue(row.original);
        return value ? <span className="font-mono text-xs">{value.slice(0, 8)}</span> : "-";
      }
    },
    {
      id: "status",
      header: t("Status", "ステータス"),
      cell: ({ row }) => {
        const status = statusValue(row.original);
        return (
          <Badge
            variant="outline"
            className={
              status === "error"
                ? "border-destructive/40 text-destructive"
                : status === "warning"
                  ? "border-warning/40 text-warning"
                  : "text-muted-foreground"
            }
          >
            {status}
          </Badge>
        );
      }
    }
  ];

  const table = useReactTable({
    data: features,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-[1] bg-muted text-left font-mono text-[10px] uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} className="whitespace-nowrap px-3 py-2.5">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const isSelected = selectedSet.has(row.original.id);
              return (
                <tr
                  key={row.id}
                  className={`cursor-pointer border-t border-border transition-colors ${
                    isSelected ? "bg-accent" : "bg-card hover:bg-muted"
                  }`}
                  onClick={(event) => handleRowSelection(row.original.id, event.shiftKey)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        {features.length === 0 ? (
          <EmptyState
            icon="search"
            title={t("No features match", "一致するフィーチャーがありません")}
            description={t(
              "Clear a filter above to see more.",
              "上のフィルターを解除すると表示されます。"
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
