import { useCallback, useMemo, useRef, useState } from "react";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

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

  // The column list is memoized so TanStack does not rebuild the row model on
  // every render — that walk is O(rows), and it was happening on each keystroke
  // in the filter bar. The handlers close over state that changes every render,
  // so they go through a ref rather than into the dependency list.
  const handlersRef = useRef({ handleRowSelection, toggleAllVisible });
  handlersRef.current = { handleRowSelection, toggleAllVisible };
  const onRowSelect = useCallback(
    (id: string, shiftKey: boolean) => handlersRef.current.handleRowSelection(id, shiftKey),
    []
  );
  const onSelectAll = useCallback(
    (checked: boolean) => handlersRef.current.toggleAllVisible(checked),
    []
  );

  const columns: ColumnDef<ReviewFeature>[] = useMemo(
    () => [
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
              onRowSelect(id, event.shiftKey);
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
    ],
    [t, selectedSet, allVisibleSelected, someVisibleSelected, visibleIds.length, onRowSelect, onSelectAll]
  );

  const table = useReactTable({
    data: features,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  // Above the threshold, only the rows in view are rendered. Every row used to
  // be, and a row is not cheap — a Radix checkbox, a swatch and a badge each —
  // so a station-sized session spent seconds building DOM nobody was looking at
  // before the table appeared at all.
  //
  // Below it the whole table stays in the DOM, which costs nothing at that size
  // and keeps find-in-page and screen-reader table navigation working on the
  // sessions where they are most likely to be used.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const windowed = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  });
  const virtualRows = virtualizer.getVirtualItems();
  const shownRows = windowed ? virtualRows.map((item) => rows[item.index]) : rows;
  const padTop = windowed && virtualRows.length ? virtualRows[0].start : 0;
  const padBottom =
    windowed && virtualRows.length
      ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {/* Fixed widths: with only a window of rows mounted, letting the browser
            size columns from their content would make them jump as you scroll. */}
        <table className="w-full min-w-[46rem] table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: "3rem" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "26%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "12%" }} />
          </colgroup>
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
            {padTop > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={7} style={{ height: padTop }} />
              </tr>
            ) : null}
            {shownRows.map((row) => {
              const isSelected = selectedSet.has(row.original.id);
              return (
                <tr
                  key={row.id}
                  style={{ height: ROW_HEIGHT }}
                  className={`cursor-pointer border-t border-border transition-colors ${
                    isSelected ? "bg-accent" : "bg-card hover:bg-muted"
                  }`}
                  onClick={(event) => onRowSelect(row.original.id, event.shiftKey)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="truncate px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {padBottom > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={7} style={{ height: padBottom }} />
              </tr>
            ) : null}
          </tbody>
        </table>

        {features.length === 0 ? (
          <EmptyState
            icon="search"
            title={t("No features match", "\u4e00\u81f4\u3059\u308b\u30d5\u30a3\u30fc\u30c1\u30e3\u30fc\u304c\u3042\u308a\u307e\u305b\u3093")}
            description={t(
              "Clear a filter above to see more.",
              "\u4e0a\u306e\u30d5\u30a3\u30eb\u30bf\u30fc\u3092\u89e3\u9664\u3059\u308b\u3068\u8868\u793a\u3055\u308c\u307e\u3059\u3002"
            )}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Row height in px; the virtualiser needs it before a row exists to measure. */
const ROW_HEIGHT = 37;

/** Rows above which the table renders only what is on screen. */
const VIRTUALIZE_ABOVE = 200;
