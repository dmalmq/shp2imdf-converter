import { useEffect, useMemo, useRef, useState } from "react";
import { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import type { AppendCandidateFeature } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { MapView } from "../shared/MapView";
import { STREET_MAP_STYLE } from "../shared/streetMapStyle";
import { Button } from "../ui";
import {
  type Facet,
  type SelectionState,
  type SelectionBase,
  facetCounts,
  includeAll,
  isDeliberateBox,
  isPickable,
  pickableMatcher,
  selectionMatcher,
  setAll,
  summarise,
  toggleFacet,
  toggleFeature,
  valueCounts
} from "./appendSelection";


type Props = {
  features: AppendCandidateFeature[];
  columnsByStem: Record<string, string[]>;
  selection: SelectionState;
  onChange: (next: SelectionState) => void;
};

type Tab = "filters" | "features" | "map";

/** Rows shown at once in the feature list; real layers run to a few hundred. */
const VISIBLE_ROWS = 120;

// Three states, because two were not enough. Everything on the chosen floor
// starts selected; deselecting one used to drop it to the same grey as the
// twenty-five floors underneath, so it vanished and could not be found again to
// put back. What the filters admit now stays blue whether or not it is in, and
// what is in is amber on top of that.
//
// The fill layer covers the unselected too, at zero opacity where nothing is
// drawn: a transparent fill is still hit-tested, and that is what makes
// clicking a room work.
const SELECTED = ["boolean", ["feature-state", "selected"], false];
const PICKABLE = ["boolean", ["feature-state", "pickable"], false];

const IN = "#f59e0b";
const IN_LINE = "#b45309";
const AVAILABLE = "#2563eb";
const CONTEXT = "#94a3b8";

/** selected -> available -> other, in that order of precedence. */
const byState = (selected: unknown, available: unknown, other: unknown) => [
  "case",
  SELECTED,
  selected,
  PICKABLE,
  available,
  other
];

const FILL_LAYER: any = {
  id: "append-candidates-fill",
  type: "fill",
  filter: ["==", ["geometry-type"], "Polygon"],
  paint: {
    "fill-color": byState(IN, AVAILABLE, CONTEXT),
    "fill-opacity": byState(0.55, 0.1, 0)
  }
};

const OUTLINE_LAYER: any = {
  id: "append-candidates-outline",
  type: "line",
  filter: ["==", ["geometry-type"], "Polygon"],
  paint: {
    "line-color": byState(IN_LINE, AVAILABLE, CONTEXT),
    "line-width": byState(1.2, 0.9, 0.5),
    "line-opacity": byState(1, 0.85, 0.45)
  }
};

const LINE_LAYER: any = {
  id: "append-candidates-line",
  type: "line",
  filter: ["==", ["geometry-type"], "LineString"],
  paint: {
    "line-color": byState(IN_LINE, AVAILABLE, CONTEXT),
    "line-width": byState(2.2, 1.4, 0.7),
    "line-opacity": byState(1, 0.85, 0.45)
  }
};

const POINT_LAYER: any = {
  id: "append-candidates-point",
  type: "circle",
  filter: ["==", ["geometry-type"], "Point"],
  paint: {
    "circle-radius": byState(5, 4, 3),
    "circle-color": byState(IN, AVAILABLE, "#e2e8f0"),
    "circle-stroke-width": 1,
    "circle-stroke-color": byState(IN_LINE, AVAILABLE, CONTEXT)
  }
};

const SOURCE_ID = "append-candidates-src";

/** Layers a click can land on. The zero-opacity fill covers polygon interiors. */
const PICKABLE_LAYERS = [
  "append-candidates-fill",
  "append-candidates-outline",
  "append-candidates-line",
  "append-candidates-point"
];

const BOX_FILL: any = {
  id: "append-box-fill",
  type: "fill",
  paint: { "fill-color": "#334155", "fill-opacity": 0.06 }
};

const BOX_LINE: any = {
  id: "append-box-line",
  type: "line",
  paint: { "line-color": "#334155", "line-width": 1.5, "line-dasharray": [2, 2] }
};

function boxPolygon(bbox: [number, number, number, number]) {
  const [minX, minY, maxX, maxY] = bbox;
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [minX, minY],
              [maxX, minY],
              [maxX, maxY],
              [minX, maxY],
              [minX, minY]
            ]
          ]
        }
      }
    ]
  };
}

function initialView(features: AppendCandidateFeature[]) {
  const points = features.map((feature) => feature.point).filter((point): point is [number, number] => !!point);
  if (points.length === 0) {
    return { longitude: 139.767, latitude: 35.681, zoom: 15 };
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  // A single point has no extent to fit, so fall back to a plain centre.
  if (minX === maxX || minY === maxY) {
    return { longitude: minX, latitude: minY, zoom: 17 };
  }
  return {
    bounds: [
      [minX, minY],
      [maxX, maxY]
    ] as [[number, number], [number, number]],
    fitBoundsOptions: { padding: 24 }
  };
}


export function AppendSelectionPanel({ features, columnsByStem, selection, onChange }: Props) {
  const { t } = useUiLanguage();
  // The map is the view people reason about, now that narrowing it no longer
  // means leaving it.
  const [tab, setTab] = useState<Tab>("map");
  const [drawing, setDrawing] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [dragStart, setDragStart] = useState<{ lngLat: [number, number]; point: [number, number] } | null>(
    null
  );
  const [dragBox, setDragBox] = useState<[number, number, number, number] | null>(null);
  const viewRef = useRef(initialView(features));

  const summary = useMemo(() => summarise(features, selection), [features, selection]);
  const matches = useMemo(() => selectionMatcher(selection), [selection]);
  const stems = useMemo(
    () => [...new Set(features.map((feature) => feature.stem).filter((stem): stem is string => !!stem))].sort(),
    [features]
  );
  const featureTypes = useMemo(
    () => [...new Set(features.map((feature) => feature.feature_type))].sort(),
    [features]
  );

  // The two axes worth having in front of you at all times. They are hoisted
  // out of the tabs because narrowing the map is the point of the map, and
  // walking to another tab to do it is backwards.
  const levels = useMemo(() => facetCounts(features, "level"), [features]);
  const categories = useMemo(() => facetCounts(features, "category"), [features]);

  const layerFor = (stem: string) =>
    selection.layers[stem] ?? { included: true, filterColumn: null, filterValues: [] };

  const setLayer = (stem: string, next: Partial<ReturnType<typeof layerFor>>) => {
    onChange({
      ...selection,
      layers: { ...selection.layers, [stem]: { ...layerFor(stem), ...next } }
    });
  };

  // Built from the features alone, so it is serialised and parsed once. Which
  // of them are selected rides in feature-state instead: re-emitting an
  // 18,000-feature collection on every click cost 3.6 seconds each, which made
  // picking rooms off the map unusable.
  const shapes = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: features
        .filter((feature) => !feature.already_imported && (feature.geometry || feature.point))
        .map((feature) => ({
          type: "Feature" as const,
          id: feature.id,
          properties: { id: feature.id },
          geometry:
            (feature.geometry as any) ??
            { type: "Point" as const, coordinates: feature.point as [number, number] }
        }))
    }),
    [features]
  );

  const byId = useMemo(() => new Map(features.map((feature) => [feature.id, feature])), [features]);

  /** The topmost feature under the cursor that the current filters admit. */
  const pickFrom = (hits: any[] | undefined): AppendCandidateFeature | undefined => {
    for (const hit of hits ?? []) {
      const candidate = byId.get(hit?.properties?.id);
      if (candidate && isPickable(candidate, selection)) {
        return candidate;
      }
    }
    return undefined;
  };

  const mapRef = useRef<MapRef>(null);
  const [sourceReady, setSourceReady] = useState(false);
  const painted = useRef<{ selected: Set<string>; pickable: Set<string> }>({
    selected: new Set(),
    pickable: new Set()
  });

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !sourceReady) {
      return;
    }
    const isIn = selectionMatcher(selection);
    const canPick = pickableMatcher(selection);
    const nextSelected = new Set<string>();
    const nextPickable = new Set<string>();
    features.forEach((feature) => {
      if (feature.already_imported) {
        return;
      }
      const visible = canPick(feature);
      if (visible) {
        nextPickable.add(feature.id);
        if (isIn(feature)) {
          nextSelected.add(feature.id);
        }
      }
    });

    // Only what changed is touched; re-emitting the whole collection instead
    // cost seconds a click on a full station.
    const previous = painted.current;
    const dirty = new Set<string>();
    [
      [previous.selected, nextSelected],
      [previous.pickable, nextPickable]
    ].forEach(([before, after]) => {
      after.forEach((id) => !before.has(id) && dirty.add(id));
      before.forEach((id) => !after.has(id) && dirty.add(id));
    });
    dirty.forEach((id) => {
      map.setFeatureState(
        { source: SOURCE_ID, id },
        { selected: nextSelected.has(id), pickable: nextPickable.has(id) }
      );
    });
    painted.current = { selected: nextSelected, pickable: nextPickable };
  }, [features, selection, sourceReady]);

  const activeBox = dragBox ?? selection.bbox;

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-[var(--color-text)]">{t("What to bring in", "取り込む対象")}</h4>
        <span className="text-xs text-[var(--color-text-muted)]" data-testid="selection-summary">
          {summary.selected} / {summary.selectable} {t("selected", "選択中")}
          {summary.selectedElsewhere > 0
            ? ` · ${summary.selectedElsewhere} ${t("on other floors", "他の階")}`
            : ""}
          {summary.alreadyImported > 0
            ? ` · ${summary.alreadyImported} ${t("already in", "取込済み")}`
            : ""}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          {t("Bring in", "取り込み")}
        </span>
        {(
          [
            ["filters", t("Everything that matches", "条件に合うものすべて")],
            ["picked", t("Only what I pick", "選んだものだけ")]
          ] as [SelectionBase, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={selection.base === value}
            onClick={() =>
              // Switching starts over: the deviation lists mean opposite things
              // on either side, so carrying them across would flip the result.
              onChange({ ...selection, base: value, includedIds: [], excludedIds: [] })
            }
            className={[
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              selection.base === value
                ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      <FacetRow
        label={t("Floors", "階")}
        facets={levels}
        active={selection.levelIds}
        onToggle={(value) =>
          onChange({ ...selection, levelIds: toggleFacet(selection.levelIds, levels, value) })
        }
        onAll={() => onChange({ ...selection, levelIds: null })}
        allLabel={t("All", "すべて")}
      />
      <FacetRow
        label={t("Categories", "分類")}
        facets={categories}
        active={selection.categories}
        onToggle={(value) =>
          onChange({ ...selection, categories: toggleFacet(selection.categories, categories, value) })
        }
        onAll={() => onChange({ ...selection, categories: null })}
        allLabel={t("All", "すべて")}
      />

      <div className="mt-3 flex gap-1" role="tablist">
        {(
          [
            ["filters", t("Filters", "絞り込み")],
            ["features", t("Features", "フィーチャ")],
            ["map", t("Map", "地図")]
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={[
              "rounded-[var(--radius-md)] px-2.5 py-1 text-xs font-medium transition-colors",
              tab === value
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "filters" ? (
        <div className="mt-3 grid gap-3">
          <div>
            <span className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
              {t("Feature types", "フィーチャ種別")}
            </span>
            <div className="mt-1 flex flex-wrap gap-2">
              {featureTypes.map((type) => {
                const checked = selection.featureTypes === null || selection.featureTypes.includes(type);
                return (
                  <label key={type} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      aria-label={type}
                      checked={checked}
                      onChange={() => {
                        const current = selection.featureTypes ?? featureTypes;
                        const next = checked
                          ? current.filter((item) => item !== type)
                          : [...current, type];
                        onChange({
                          ...selection,
                          featureTypes: next.length === featureTypes.length ? null : next
                        });
                      }}
                    />
                    {type}
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <span className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
              {t("Layers", "レイヤー")}
            </span>
            {/* One compact row per layer, two abreast and capped: a station
                hands over forty-odd of these and they cannot all be cards. */}
            <div className="mt-1 grid max-h-72 gap-x-4 overflow-y-auto pr-1 sm:grid-cols-2">
              {stems.map((stem) => {
                const layer = layerFor(stem);
                const columns = columnsByStem[stem] ?? [];
                return (
                  <div key={stem} className="py-0.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={stem}
                        checked={layer.included}
                        onChange={(event) => setLayer(stem, { included: event.target.checked })}
                      />
                      <span className="flex-1 truncate font-mono text-xs" title={stem}>
                        {stem}
                      </span>
                      {layer.included && columns.length > 0 ? (
                        <select
                          aria-label={`${stem} filter column`}
                          className="w-28 shrink-0 rounded-[var(--radius-md)] border border-[var(--color-border)] px-1 py-0.5 text-xs"
                          value={layer.filterColumn ?? ""}
                          onChange={(event) =>
                            setLayer(stem, {
                              filterColumn: event.target.value || null,
                              filterValues: event.target.value
                                ? valueCounts(features, stem, event.target.value).map((row) => row.value)
                                : []
                            })
                          }
                        >
                          <option value="">{t("No filter", "絞り込みなし")}</option>
                          {columns.map((column) => (
                            <option key={column} value={column}>
                              {column}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>

                    {layer.included && layer.filterColumn ? (
                      <ul className="mb-1 ml-6 grid max-h-32 gap-0.5 overflow-y-auto">
                        {valueCounts(features, stem, layer.filterColumn).map((row) => (
                          <li key={row.value}>
                            <label className="flex items-center justify-between gap-2 text-xs">
                              <span className="flex items-center gap-1.5 truncate">
                                <input
                                  type="checkbox"
                                  aria-label={`${layer.filterColumn} ${row.value || "(blank)"}`}
                                  checked={layer.filterValues.includes(row.value)}
                                  onChange={(event) =>
                                    setLayer(stem, {
                                      filterValues: event.target.checked
                                        ? [...layer.filterValues, row.value]
                                        : layer.filterValues.filter((item) => item !== row.value)
                                    })
                                  }
                                />
                                {row.value || t("(blank)", "(空)")}
                              </span>
                              <span className="shrink-0 text-[var(--color-text-muted)]">{row.count}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "features" ? (
        <div className="mt-3">
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => onChange(setAll(selection, features, true))}>
              {t("Select all", "すべて選択")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onChange(setAll(selection, features, false))}>
              {t("Select none", "選択解除")}
            </Button>
          </div>
          <ul className="mt-1 max-h-80 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {features.slice(0, VISIBLE_ROWS).map((feature) => (
              <li
                key={feature.id}
                className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1 text-xs last:border-b-0"
              >
                <input
                  type="checkbox"
                  aria-label={feature.name || feature.id}
                  disabled={feature.already_imported}
                  checked={matches(feature)}
                  onChange={() => onChange(toggleFeature(selection, feature))}
                />
                <span className="w-20 shrink-0 text-[var(--color-text-muted)]">{feature.feature_type}</span>
                <span className="w-24 shrink-0 text-[var(--color-text-secondary)]">{feature.category ?? ""}</span>
                <span className="truncate">{feature.name ?? t("(unnamed)", "(名称なし)")}</span>
                {feature.already_imported ? (
                  <span className="ml-auto shrink-0 text-[var(--color-text-muted)]">
                    {t("already in", "取込済み")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {features.length > VISIBLE_ROWS ? (
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {t(
                `Showing the first ${VISIBLE_ROWS} of ${features.length}. Narrow it down on the Filters tab.`,
                `${features.length} 件中 ${VISIBLE_ROWS} 件を表示中。絞り込みタブで絞ってください。`
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {tab === "map" ? (
        <div className="mt-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Button
              variant={drawing ? "primary" : "secondary"}
              size="sm"
              aria-pressed={drawing}
              onClick={() => setDrawing((current) => !current)}
            >
              {drawing ? t("Drawing a box...", "範囲を描画中...") : t("Draw box", "範囲を描く")}
            </Button>
            {selection.bbox && selection.base !== "picked" ? (
              <Button variant="ghost" size="sm" onClick={() => onChange({ ...selection, bbox: null })}>
                {t("Clear box", "範囲を解除")}
              </Button>
            ) : null}
            <span className="ml-auto flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: IN }} />
                {t("coming in", "取り込む")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: AVAILABLE, opacity: 0.5 }} />
                {t("available", "選択可")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CONTEXT, opacity: 0.5 }} />
                {t("filtered out", "対象外")}
              </span>
            </span>
            <span className="w-full text-xs text-[var(--color-text-muted)]">
              {drawing
                ? selection.base === "picked"
                  ? t("Drag a box around what you want.", "取り込みたい範囲をドラッグしてください。")
                  : t("Drag a box to narrow to what is inside.", "ドラッグした範囲内に絞り込みます。")
                : t(
                    "Click a feature to add or remove it. Pan and zoom freely.",
                    "フィーチャをクリックすると追加・削除できます。地図は自由に移動・拡大できます。"
                  )}
            </span>
          </div>

          {selection.bbox && summary.selected === 0 ? (
            <p className="mb-1 rounded-[var(--radius-sm)] border border-[var(--color-warning)]/20 bg-[var(--color-warning-muted)] px-2 py-1 text-xs text-[var(--color-warning)]">
              {t(
                "The box does not contain anything. Clear it, or draw one over the features you want.",
                "この範囲には何も含まれていません。解除するか、必要なフィーチャを囲んで描き直してください。"
              )}
            </p>
          ) : null}

          <div className="h-[26rem] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <MapView
              ref={mapRef}
              initialViewState={viewRef.current}
              onLoad={() => {
                // A remount starts with a blank source, so forget what was
                // painted and let the effect apply the whole selection again.
                painted.current = { selected: new Set(), pickable: new Set() };
                setSourceReady(true);
              }}
              mapStyle={STREET_MAP_STYLE as any}
              // Only a deliberate draw takes the map's own drag away. Panning is
              // how you aim at a building, and stealing it turned every pan into
              // a box that selected nothing.
              dragPan={!drawing}
              cursor={drawing ? "crosshair" : hovering ? "pointer" : undefined}
              interactiveLayerIds={drawing ? undefined : PICKABLE_LAYERS}
              style={{ width: "100%", height: "100%" }}
              onClick={(event: any) => {
                if (drawing) {
                  return;
                }
                const candidate = pickFrom(event.features);
                if (candidate) {
                  onChange(toggleFeature(selection, candidate));
                }
              }}
              onMouseDown={(event: any) => {
                if (!drawing) {
                  return;
                }
                setDragStart({
                  lngLat: [event.lngLat.lng, event.lngLat.lat],
                  point: [event.point.x, event.point.y]
                });
                setDragBox(null);
              }}
              onMouseMove={(event: any) => {
                if (!dragStart) {
                  setHovering(!drawing && pickFrom(event.features) !== undefined);
                  return;
                }
                const [x0, y0] = dragStart.lngLat;
                const { lng, lat } = event.lngLat;
                setDragBox([
                  Math.min(x0, lng),
                  Math.min(y0, lat),
                  Math.max(x0, lng),
                  Math.max(y0, lat)
                ]);
              }}
              onMouseUp={(event: any) => {
                if (dragStart && dragBox) {
                  if (isDeliberateBox(dragStart.point, [event.point.x, event.point.y])) {
                    const [minX, minY, maxX, maxY] = dragBox;
                    if (selection.base === "picked") {
                      // Nothing is in by default here, so a box has to add what
                      // it covers rather than narrow what is already in.
                      const canPick = pickableMatcher(selection);
                      onChange(
                        includeAll(
                          selection,
                          features.filter(
                            (feature) =>
                              canPick(feature) &&
                              feature.point &&
                              feature.point[0] >= minX &&
                              feature.point[0] <= maxX &&
                              feature.point[1] >= minY &&
                              feature.point[1] <= maxY
                          )
                        )
                      );
                    } else {
                      onChange({ ...selection, bbox: dragBox });
                    }
                    setDrawing(false);
                  }
                }
                setDragStart(null);
                setDragBox(null);
              }}
            >
              <Source id={SOURCE_ID} type="geojson" data={shapes} promoteId="id">
                <Layer {...FILL_LAYER} />
                <Layer {...OUTLINE_LAYER} />
                <Layer {...LINE_LAYER} />
                <Layer {...POINT_LAYER} />
              </Source>
              {activeBox ? (
                <Source id="append-box-src" type="geojson" data={boxPolygon(activeBox)}>
                  <Layer {...BOX_FILL} />
                  <Layer {...BOX_LINE} />
                </Source>
              ) : null}
            </MapView>
          </div>
        </div>
      ) : null}

    </section>
  );
}

type FacetRowProps = {
  label: string;
  facets: Facet[];
  active: string[] | null;
  onToggle: (value: string) => void;
  onAll: () => void;
  allLabel: string;
};

/** One global axis as toggle chips. Wraps and scrolls: a station has 26 floors
 *  and a category list to match, and neither fits on a line. */
function FacetRow({ label, facets, active, onToggle, onAll, allLabel }: FacetRowProps) {
  if (facets.length < 2) {
    return null;
  }
  const allOn = active === null;
  return (
    <div className="mt-2 flex items-start gap-2">
      <span className="w-16 shrink-0 pt-1 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </span>
      <div className="flex max-h-16 flex-1 flex-wrap gap-1 overflow-y-auto">
        <button
          type="button"
          aria-pressed={allOn}
          onClick={onAll}
          className={[
            "rounded-full border px-2 py-0.5 text-xs transition-colors",
            allOn
              ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
              : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
          ].join(" ")}
        >
          {allLabel}
        </button>
        {facets.map((facet) => {
          // Neutral while "All" is active: nothing has been chosen yet, so
          // highlighting every chip would promise a selection that is not there.
          const on = active !== null && active.includes(facet.value);
          return (
            <button
              key={facet.value}
              type="button"
              aria-label={`${label} ${facet.label}`}
              aria-pressed={on}
              onClick={() => onToggle(facet.value)}
              className={[
                "rounded-full border px-2 py-0.5 text-xs transition-colors",
                on
                  ? "border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 text-[var(--color-text)]"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
              ].join(" ")}
            >
              {facet.label}{" "}
              <span className="text-[var(--color-text-muted)]">{facet.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
