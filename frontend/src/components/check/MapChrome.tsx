import { Layers } from "lucide-react";
import type { ReactNode } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { FloorGroup } from "../review/floorGroups";
import { Popover, PopoverContent, PopoverTrigger } from "../ui";
import { cn } from "@/lib/utils";

/** Floors top to bottom, the shown one dark, and a dot where something is left to do. */
export function FloorSwitcher({
  floors,
  value,
  mustFix,
  canWait,
  onChange
}: {
  floors: FloorGroup[];
  /** Floor id, or "" for every floor. */
  value: string;
  mustFix: ReadonlySet<string>;
  canWait: ReadonlySet<string>;
  onChange: (floorId: string) => void;
}) {
  const { t } = useUiLanguage();
  const item = (id: string, label: string, dot: "must" | "wait" | null) => (
    <button
      key={id || "all"}
      type="button"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={cn(
        "flex w-[76px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        value === id ? "bg-foreground text-background" : "text-foreground hover:bg-muted"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("h-[7px] w-[7px] shrink-0 rounded", dot === "must" ? "bg-destructive" : "bg-warning")}
        />
      ) : null}
    </button>
  );
  return (
    <nav
      aria-label={t("Floors", "フロア")}
      className="absolute left-5 top-5 z-10 flex max-h-[calc(100%-5rem)] flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-sm"
    >
      {[...floors]
        .reverse()
        .map((floor) => item(floor.id, floor.label, mustFix.has(floor.label) ? "must" : canWait.has(floor.label) ? "wait" : null))}
      {item("", t("All", "すべて"), null)}
    </nav>
  );
}

export type LayerPill = { key: string; label: string; on: boolean };

function Pill({ pressed, onClick, children, tone }: { pressed: boolean; onClick: () => void; children: ReactNode; tone: "view" | "layer" }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-full py-[5px] text-xs font-medium",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "view" ? "px-3" : "px-2.5",
        tone === "view"
          ? pressed
            ? "bg-foreground text-background"
            : "text-muted-foreground hover:text-foreground"
          : pressed
            ? "bg-accent text-primary"
            : "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </button>
  );
}

/** Map or table, then the layers people switch most, then every layer. */
export function MapToolbar({
  view,
  onView,
  layers,
  onToggleLayer,
  allLayers
}: {
  view: "map" | "table";
  onView: (view: "map" | "table") => void;
  layers: LayerPill[];
  onToggleLayer: (key: string) => void;
  allLayers: ReactNode;
}) {
  const { t } = useUiLanguage();
  return (
    <div className="absolute right-5 top-5 z-10 flex items-center gap-1.5 rounded-xl border border-border bg-card p-1.5 shadow-sm">
      <div role="group" aria-label={t("View", "表示")} className="flex gap-1.5">
        <Pill tone="view" pressed={view === "map"} onClick={() => onView("map")}>
          {t("Map", "地図")}
        </Pill>
        <Pill tone="view" pressed={view === "table"} onClick={() => onView("table")}>
          {t("Table", "表")}
        </Pill>
      </div>
      {view === "map" ? (
        <>
          <span aria-hidden="true" className="h-5 w-px bg-border" />
          <div role="group" aria-label={t("Layers", "レイヤー")} className="flex gap-1.5">
            {layers.map((layer) => (
              <Pill key={layer.key} tone="layer" pressed={layer.on} onClick={() => onToggleLayer(layer.key)}>
                {layer.label}
              </Pill>
            ))}
          </div>
          <Popover>
            <PopoverTrigger
              aria-label={t("All layers", "すべてのレイヤー")}
              title={t("All layers", "すべてのレイヤー")}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Layers className="h-3.5 w-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              {allLayers}
            </PopoverContent>
          </Popover>
        </>
      ) : null}
    </div>
  );
}
