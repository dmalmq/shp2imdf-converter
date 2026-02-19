import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from "@tanstack/react-table";

import { featureName, type ReviewFeature } from "./types";


type Props = {
  features: ReviewFeature[];
  selectedFeatureIds: string[];
  onSelectFeature: (id: string, multi?: boolean) => void;
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


export function TablePanel({ features, selectedFeatureIds, onSelectFeature }: Props) {
  const selectedSet = new Set(selectedFeatureIds);

  const columns: ColumnDef<ReviewFeature>[] = [
    {
      id: "select",
      header: "",
      cell: ({ row }) => {
        const id = row.original.id;
        return (
          <input
            type="checkbox"
            checked={selectedSet.has(id)}
            onChange={() => onSelectFeature(id, true)}
            onClick={(event) => event.stopPropagation()}
          />
        );
      }
    },
    {
      accessorKey: "id",
      header: "ID",
      cell: ({ getValue }) => {
        const value = String(getValue());
        return <span className="font-mono text-xs">{value.slice(0, 8)}</span>;
      }
    },
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => featureName(row.original) || "—"
    },
    {
      accessorKey: "feature_type",
      header: "Feature Type",
      cell: ({ getValue }) => <span className="capitalize">{String(getValue())}</span>
    },
    {
      id: "category",
      header: "Category",
      cell: ({ row }) => categoryValue(row.original) || "—"
    },
    {
      id: "level",
      header: "Level",
      cell: ({ row }) => {
        const value = levelValue(row.original);
        return value ? <span className="font-mono text-xs">{value.slice(0, 8)}</span> : "—";
      }
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const status = statusValue(row.original);
        const className =
          status === "error"
            ? "bg-red-100 text-red-700"
            : status === "warning"
              ? "bg-amber-100 text-amber-700"
              : "bg-emerald-100 text-emerald-700";
        return <span className={`rounded px-2 py-0.5 text-xs ${className}`}>{status}</span>;
      }
    }
  ];

  const table = useReactTable({
    data: features,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <div className="rounded border bg-white">
      <div className="max-h-[360px] overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} className="px-2 py-2">
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
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
                  className={`cursor-pointer border-t ${isSelected ? "bg-blue-50" : "bg-white hover:bg-slate-50"}`}
                  onClick={(event) => onSelectFeature(row.original.id, event.shiftKey)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-2 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
